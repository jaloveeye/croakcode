import path from "path"
import { desc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Log from "@croakcode/core/util/log"
import type { Permission } from "../permission"
import type { SessionID } from "../session/schema"
import { Database } from "@/storage/db"
import { AgentRunTable } from "./delegation.sql"
import { Effective } from "./effective"
import { Grants } from "./grants"
import { Policy } from "./policy"
import { Registry } from "./registry"
import { HUMAN_LOCAL, type PrincipalID } from "./schema"

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

    const beginRun = Effect.fn("DelegationGuard.beginRun")(function* (input: {
      readonly sessionID: SessionID
      readonly parentID?: SessionID
      readonly agent: string
    }) {
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
      if (!run) return yield* new DelegationDeniedError({ permission, reason: "no_run" })
      const decision = yield* effective.decide({
        runId: run.id,
        permission,
        pattern,
        ...(toolLevel ? { toolLevel: true } : {}),
        ...(!toolLevel && path.isAbsolute(pattern) ? { path: pattern } : {}),
      })
      if (decision.action === "deny") {
        return yield* new DelegationDeniedError({ permission, reason: decision.reason })
      }
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

      // Reuse the child's principal on resume when it is still ours and active.
      const previous = lastPrincipalOf(input.childSessionID)
      const known = previous ? yield* registry.getPrincipal(previous) : undefined
      const delegatee =
        known && known.status === "active" && known.ownerId === delegator.id
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

      yield* registry
        .startRun({
          principalId: delegatee.id,
          sessionId: input.childSessionID,
          parentRunId: parentRun.id,
          grantId: grant.id,
          policyRevision: grant.policyRevision,
        })
        .pipe(Effect.mapError((err) => deny(err._tag)))
    })

    return Service.of({ beginRun, endRun, checkTool, checkPatterns, delegate })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Layer.mergeAll(Registry.defaultLayer, Grants.defaultLayer, Effective.defaultLayer)),
)

export * as Guard from "./guard"
