import path from "path"
import { desc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Log from "@croakcode/core/util/log"
import type { Permission } from "../permission"
import type { SessionID } from "../session/schema"
import { Database } from "@/storage/db"
import { AgentRunTable } from "./delegation.sql"
import { Audit } from "./audit"
import { Effective } from "./effective"
import { Grants } from "./grants"
import { Permit } from "./permit"
import { PermitClient } from "./permit-client"
import { PermitNonce } from "./permit-nonce"
import { Policy } from "./policy"
import { Registry } from "./registry"
import { HUMAN_LOCAL, type PrincipalID, type RunID } from "./schema"

// Phase 4 Task 5/6 — the runtime side of the delegation layer.
//
// - beginRun/endRun give every prompt loop a run: a top-level session runs
//   under a root principal owned by the local human; a delegated child runs
//   under the run the task tool created for it.
// - checkTool/checkPatterns re-check authority right before a tool runs, by
//   reading the session's active run and its chain from the database. No run,
//   unreadable state, or a deny from any layer stops the call.
// - delegate creates the child principal, grant and run for the task tool.

const log = Log.create({ service: "delegation.guard" })

/** Lifetime of a root grant issued by the task tool. Child grants inherit their parent's. */
export const ROOT_GRANT_TTL_MS = 24 * 60 * 60 * 1000

export class DelegationDeniedError extends Schema.TaggedErrorClass<DelegationDeniedError>()("DelegationDeniedError", {
  permission: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Delegated authority does not allow "${this.permission}" here (${this.reason}). Do not retry this call.`
  }
}

export interface Interface {
  readonly beginRun: (input: { readonly sessionID: SessionID; readonly parentID?: SessionID; readonly agent: string }) => Effect.Effect<void>
  readonly endRun: (sessionID: SessionID, status: "completed" | "aborted") => Effect.Effect<void>
  /** The session's running run id, sent to the gate so its records join this audit by run. */
  readonly runOf: (sessionID: SessionID) => Effect.Effect<string | undefined>
  readonly checkTool: (sessionID: SessionID, permission: string) => Effect.Effect<void, DelegationDeniedError>
  readonly checkPatterns: (
    sessionID: SessionID,
    permission: string,
    patterns: readonly string[],
  ) => Effect.Effect<void, DelegationDeniedError>
  readonly delegate: (input: {
    readonly parentSessionID: SessionID
    readonly childSessionID: SessionID
    readonly agent: string
    readonly capabilities: Permission.Ruleset
    readonly inherited: Permission.Ruleset
  }) => Effect.Effect<{ readonly runId: RunID }, DelegationDeniedError>
  /**
   * CX-03: whether a child run's result may be delivered into `sessionID`.
   * Only the session of the run that delegated it qualifies.
   */
  readonly deliverable: (childRunId: RunID, sessionID: SessionID) => Effect.Effect<boolean>
  /**
   * Phase 4 Task 9: in gate mode with CROAKCODE_EXECUTION_PERMIT=required,
   * the call runs only with a Gate-signed permit bound to it. Off otherwise.
   */
  readonly authorizeExecution: (input: {
    readonly sessionID: SessionID
    readonly tool: string
    readonly args: unknown
    readonly mode: "gate" | "direct"
  }) => Effect.Effect<void, DelegationDeniedError>
}

export class Service extends Context.Service<Service, Interface>()("@croakcode/DelegationGuard") {}

function currentRevision() {
  const policy = Policy.load()
  return policy.status === "invalid" ? 0 : policy.revision
}

/** The principal that last ran in this session, if any. */
function lastPrincipalOf(sessionID: SessionID): PrincipalID | undefined {
  const row = Database.use((db) =>
    db
      .select({ principal: AgentRunTable.principal_id })
      .from(AgentRunTable)
      .where(eq(AgentRunTable.session_id, sessionID))
      .orderBy(desc(AgentRunTable.id))
      .get(),
  )
  return row?.principal
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* Registry.Service
    const grants = yield* Grants.Service
    const effective = yield* Effective.Service
    const permits = yield* PermitClient.Service
    const nonces = new PermitNonce.Store()

    const beginRun = Effect.fn("DelegationGuard.beginRun")(function* (input: {
      readonly sessionID: SessionID
      readonly parentID?: SessionID
      readonly agent: string
    }) {
      Audit.pruneIfDue()
      const active = yield* registry.activeRun(input.sessionID)
      if (active) return
      // A delegated child gets its run from the task tool. Without one it has
      // no authority; every tool check then denies (INV-5.4).
      if (input.parentID) {
        log.warn("child session has no delegated run", { sessionID: input.sessionID })
        return
      }
      const previous = lastPrincipalOf(input.sessionID)
      const known = previous ? yield* registry.getPrincipal(previous) : undefined
      const principal =
        known && known.status === "active" && known.ownerId === HUMAN_LOCAL
          ? known
          : yield* registry
              .issuePrincipal({
                ownerId: HUMAN_LOCAL,
                definition: input.agent,
                role: "root",
                // The root's own rules are enforced by the permission engine;
                // the delegation layer adds nothing on top for the local human.
                capabilities: [{ permission: "*", pattern: "*", action: "allow" }],
              })
              .pipe(Effect.orDie)
      // A revoked root principal cannot start a run; checks then deny.
      if (principal.status !== "active") return
      yield* registry
        .startRun({ principalId: principal.id, sessionId: input.sessionID, policyRevision: currentRevision() })
        .pipe(Effect.ignore)
    })

    const endRun = Effect.fn("DelegationGuard.endRun")(function* (
      sessionID: SessionID,
      status: "completed" | "aborted",
    ) {
      const active = yield* registry.activeRun(sessionID)
      if (active) yield* registry.endRun(active.id, status)
    })

    const check = Effect.fnUntraced(function* (
      sessionID: SessionID,
      permission: string,
      pattern: string,
      toolLevel: boolean,
    ) {
      const run = yield* registry.activeRun(sessionID).pipe(Effect.catchDefect(() => Effect.succeed(undefined)))
      if (!run) {
        Audit.record({ eventType: "tool.denied", sessionId: sessionID, tool: permission, decision: "deny", errorCode: "no_run" })
        return yield* new DelegationDeniedError({ permission, reason: "no_run" })
      }
      const decision = yield* effective.decide({
        runId: run.id,
        permission,
        pattern,
        ...(toolLevel ? { toolLevel: true } : {}),
        ...(!toolLevel && path.isAbsolute(pattern) ? { path: pattern } : {}),
      })
      // AU-03: the tool-level decision is recorded for every call; pattern
      // checks record denies only, so one call does not write one row per path.
      const base = {
        principalId: run.principalId,
        runId: run.id,
        sessionId: sessionID,
        ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
        ...(run.grantId ? { grantId: run.grantId } : {}),
        tool: permission,
        policyRevision: decision.policyRevision,
      }
      if (decision.action === "deny") {
        Audit.record({ ...base, eventType: "tool.denied", decision: "deny", errorCode: decision.reason })
        return yield* new DelegationDeniedError({ permission, reason: decision.reason })
      }
      if (toolLevel) Audit.record({ ...base, eventType: "tool.allowed", decision: "allow" })
    })

    const checkTool = Effect.fn("DelegationGuard.checkTool")(function* (sessionID: SessionID, permission: string) {
      yield* check(sessionID, permission, "*", true)
    })

    const checkPatterns = Effect.fn("DelegationGuard.checkPatterns")(function* (
      sessionID: SessionID,
      permission: string,
      patterns: readonly string[],
    ) {
      for (const pattern of patterns) yield* check(sessionID, permission, pattern, false)
    })

    const delegate = Effect.fn("DelegationGuard.delegate")(function* (input: {
      readonly parentSessionID: SessionID
      readonly childSessionID: SessionID
      readonly agent: string
      readonly capabilities: Permission.Ruleset
      readonly inherited: Permission.Ruleset
    }) {
      const deny = (reason: string) => new DelegationDeniedError({ permission: "task", reason })
      const parentRun = yield* registry.activeRun(input.parentSessionID)
      if (!parentRun) return yield* deny("no_parent_run")
      const delegator = yield* registry.getPrincipal(parentRun.principalId)
      if (!delegator || delegator.status !== "active") return yield* deny("principal_inactive")
      const parentGrant = parentRun.grantId ? yield* grants.get(parentRun.grantId) : undefined
      if (parentRun.grantId && !parentGrant) return yield* deny("grant_inactive")

      // CX-04: a child session that already ran belongs to the principal that
      // delegated it. Resuming it from any other delegator would hand that
      // principal the child's context, so it is refused. A revoked child
      // principal is not revived.
      const previous = lastPrincipalOf(input.childSessionID)
      const known = previous ? yield* registry.getPrincipal(previous) : undefined
      if (known && known.ownerId !== delegator.id) return yield* deny("context_out_of_scope")
      if (known && known.status !== "active") return yield* deny("principal_inactive")
      const delegatee = known
        ? known
        : yield* registry
              .issuePrincipal({
                ownerId: delegator.id,
                definition: input.agent,
                role: input.agent,
                capabilities: input.capabilities,
              })
              .pipe(Effect.mapError((err) => deny(err._tag)))

      const ctx = yield* InstanceState.context
      // Outside a git repository the worktree is "/"; the project directory
      // is the narrowest trusted root then.
      const root = { paths: [ctx.worktree === "/" ? ctx.directory : ctx.worktree] }
      const revision = currentRevision()
      const grant = yield* grants
        .issue({
          delegatorPrincipalId: delegator.id,
          delegateePrincipalId: delegatee.id,
          ...(parentGrant ? { parentGrantId: parentGrant.id } : { bound: root }),
          parentRunId: parentRun.id,
          capabilities: Grants.delegationCapabilities({
            delegator: delegator.capabilities,
            ...(parentGrant ? { parent: parentGrant.capabilities } : {}),
            inherited: input.inherited,
          }),
          scope: parentGrant ? parentGrant.scope : root,
          constraints: parentGrant ? parentGrant.constraints : [],
          expiresAt: parentGrant ? parentGrant.expiresAt : Date.now() + ROOT_GRANT_TTL_MS,
          policyRevision: Math.max(revision, parentGrant?.policyRevision ?? 0),
          maxDepth: (() => {
            const policy = Policy.load()
            return policy.status === "valid" ? policy.maxDelegationDepth : undefined
          })(),
        })
        .pipe(Effect.mapError((err) => deny(err.reason)))

      const run = yield* registry
        .startRun({
          principalId: delegatee.id,
          sessionId: input.childSessionID,
          parentRunId: parentRun.id,
          grantId: grant.id,
          policyRevision: grant.policyRevision,
        })
        .pipe(Effect.mapError((err) => deny(err._tag)))
      return { runId: run.id }
    })

    const deliverable = Effect.fn("DelegationGuard.deliverable")(function* (
      childRunId: RunID,
      sessionID: SessionID,
    ) {
      return yield* Effect.gen(function* () {
        const child = yield* registry.getRun(childRunId)
        if (!child?.parentRunId) return false
        const parent = yield* registry.getRun(child.parentRunId)
        return parent?.sessionId === sessionID
      }).pipe(Effect.catchDefect(() => Effect.succeed(false)))
    })

    const authorizeExecution = Effect.fn("DelegationGuard.authorizeExecution")(function* (input: {
      readonly sessionID: SessionID
      readonly tool: string
      readonly args: unknown
      readonly mode: "gate" | "direct"
    }) {
      const config = Permit.loadConfig()
      if (!config.enabled || input.mode !== "gate") return
      const run = yield* registry.activeRun(input.sessionID).pipe(Effect.catchDefect(() => Effect.succeed(undefined)))
      const deny = (reason: string) => {
        Audit.record({
          eventType: "tool.denied",
          sessionId: input.sessionID,
          tool: input.tool,
          decision: "deny",
          errorCode: reason,
          ...(run ? { runId: run.id, principalId: run.principalId } : {}),
        })
        return new DelegationDeniedError({ permission: input.tool, reason })
      }
      // Verification is on: anything missing is a deny (PT-06).
      if (!config.publicKey) return yield* deny("permit_no_key")
      if (!config.url) return yield* deny("permit_no_url")
      if (!run) return yield* deny("no_run")
      const expected = {
        sid: input.sessionID,
        pid: run.principalId,
        rid: run.id,
        tool: input.tool,
        args: Permit.argsHash(input.args),
      }
      const token = yield* permits
        .request(config.url, { ...expected, rev: currentRevision() })
        .pipe(Effect.mapError(() => deny("permit_unavailable")))
      const verdict = Permit.verify(token, expected, { publicKey: config.publicKey, nonces })
      if (!verdict.ok) return yield* deny(verdict.reason)
    })

    const runOf = Effect.fn("DelegationGuard.runOf")(function* (sessionID: SessionID) {
      const run = yield* registry.activeRun(sessionID).pipe(Effect.catchDefect(() => Effect.succeed(undefined)))
      return run?.id
    })

    return Service.of({ beginRun, endRun, runOf, checkTool, checkPatterns, delegate, deliverable, authorizeExecution })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(
    Layer.mergeAll(Registry.defaultLayer, Grants.defaultLayer, Effective.defaultLayer, PermitClient.defaultLayer),
  ),
)

export * as Guard from "./guard"
