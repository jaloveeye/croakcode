import path from "path"
import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { AppFileSystem } from "@croakcode/core/filesystem"
import type { Permission } from "../permission"
import { Database } from "@/storage/db"
import { DelegationGrantTable } from "./delegation.sql"
import { Audit } from "./audit"
import { Lattice } from "./lattice"
import { Registry } from "./registry"
import {
  GrantID,
  type GrantConstraint,
  type GrantScope,
  type GrantStatus,
  type PrincipalID,
  type RunID,
} from "./schema"

// Phase 4 Task 3 — Delegation Store.
//
// A grant hands a subset of the delegator's authority to a delegatee. Issue
// checks the chain invariants (INV-3.1..3.6) and the depth limit before
// storing. Execution-time enforcement (the intersection of every layer) is
// Task 4/5; these checks stop a grant that is wider than its source from
// being recorded at all.

/** Phase 4 decision 7: at most 3 levels. Admin policy may lower it. */
export const MAX_DELEGATION_DEPTH = 3

export function effectiveMaxDepth(configured: number | undefined) {
  if (configured === undefined || !Number.isInteger(configured) || configured < 0) return MAX_DELEGATION_DEPTH
  return Math.min(configured, MAX_DELEGATION_DEPTH)
}

/**
 * The capabilities the task tool puts in a grant: allow everything, then the
 * denies of the parent grant, the delegator and the inherited ceiling. The
 * parent-run and own-policy layers bound what the delegatee can actually do;
 * the grant carries the denies along the chain so it never escalates.
 */
export function delegationCapabilities(input: {
  readonly delegator: Permission.Ruleset
  readonly parent?: Permission.Ruleset
  readonly inherited: Permission.Ruleset
}): Permission.Ruleset {
  const denies = (rules: Permission.Ruleset = []) => rules.filter((rule) => rule.action === "deny")
  return [
    { permission: "*", pattern: "*", action: "allow" },
    ...denies(input.parent),
    ...denies(input.delegator),
    ...denies(input.inherited),
  ]
}

export type Grant = {
  readonly id: GrantID
  readonly delegatorPrincipalId: PrincipalID
  readonly delegateePrincipalId: PrincipalID
  readonly parentGrantId?: GrantID
  readonly parentRunId: RunID
  readonly capabilities: Permission.Ruleset
  readonly scope: GrantScope
  readonly constraints: readonly GrantConstraint[]
  readonly expiresAt: number
  readonly status: GrantStatus
  readonly depth: number
  readonly policyRevision: number
  readonly timeCreated: number
}

export type RejectReason =
  | "capability_escalation"
  | "scope_escalation"
  | "constraint_weakened"
  | "expiry_extended"
  | "expired"
  | "revision_regressed"
  | "cycle"
  | "depth_exceeded"
  | "parent_inactive"
  | "parent_missing"
  | "delegator_mismatch"
  | "run_mismatch"
  | "principal_inactive"

export class GrantRejectedError extends Schema.TaggedErrorClass<GrantRejectedError>()("DelegationGrantRejectedError", {
  reason: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return `Delegation grant rejected (${this.reason}): ${this.detail}`
  }
}

export type IssueInput = {
  readonly delegatorPrincipalId: PrincipalID
  readonly delegateePrincipalId: PrincipalID
  readonly parentGrantId?: GrantID
  readonly parentRunId: RunID
  readonly capabilities: Permission.Ruleset
  readonly scope: GrantScope
  /**
   * Scope bound for a root grant (no parent grant), set by the runtime from
   * trusted state such as the project worktree. Ignored when a parent grant
   * exists: the parent's scope is the bound then.
   */
  readonly bound?: GrantScope
  readonly constraints: readonly GrantConstraint[]
  readonly expiresAt: number
  readonly policyRevision: number
  readonly maxDepth?: number
}

export interface Interface {
  readonly issue: (input: IssueInput) => Effect.Effect<Grant, GrantRejectedError>
  readonly get: (id: GrantID) => Effect.Effect<Grant | undefined>
  readonly listByDelegatee: (principalId: PrincipalID) => Effect.Effect<Grant[]>
  /** The grant followed by each ancestor up to the root grant. */
  readonly listChain: (id: GrantID) => Effect.Effect<Grant[]>
  readonly expire: (id: GrantID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@croakcode/DelegationGrants") {}

type Row = typeof DelegationGrantTable.$inferSelect

function toGrant(row: Row): Grant {
  return {
    id: row.id,
    delegatorPrincipalId: row.delegator_principal_id,
    delegateePrincipalId: row.delegatee_principal_id,
    ...(row.parent_grant_id != null ? { parentGrantId: row.parent_grant_id } : {}),
    parentRunId: row.parent_run_id,
    capabilities: row.capabilities,
    scope: row.scope,
    constraints: row.constraints,
    expiresAt: row.expires_at,
    status: row.status,
    depth: row.depth,
    policyRevision: row.policy_revision,
    timeCreated: row.time_created,
  }
}

function insideScope(child: GrantScope, bound: GrantScope) {
  return (
    child.paths.length > 0 &&
    child.paths.every(
      (item) =>
        path.isAbsolute(item) &&
        bound.paths.some((root) => path.isAbsolute(root) && AppFileSystem.contains(root, item)),
    )
  )
}

function sameConstraint(a: GrantConstraint, b: GrantConstraint) {
  return a.kind === b.kind && JSON.stringify(a.value) === JSON.stringify(b.value)
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* Registry.Service

    const read = (id: GrantID) =>
      Database.use((db) => db.select().from(DelegationGrantTable).where(eq(DelegationGrantTable.id, id)).get())

    const chainOf = (id: GrantID) => {
      const out: Grant[] = []
      const seen = new Set<string>()
      let next: GrantID | undefined = id
      while (next && !seen.has(next)) {
        seen.add(next)
        const row = read(next)
        if (!row) break
        out.push(toGrant(row))
        next = row.parent_grant_id ?? undefined
      }
      return out
    }

    const issue = Effect.fn("DelegationGrants.issue")(function* (input: IssueInput) {
      const reject = (reason: RejectReason, detail: string) => new GrantRejectedError({ reason, detail })
      const now = Date.now()

      const delegator = yield* registry.getPrincipal(input.delegatorPrincipalId)
      const delegatee = yield* registry.getPrincipal(input.delegateePrincipalId)
      if (delegator?.status !== "active") return yield* reject("principal_inactive", "delegator is missing or revoked")
      if (delegatee?.status !== "active") return yield* reject("principal_inactive", "delegatee is missing or revoked")

      const run = yield* registry.getRun(input.parentRunId)
      if (!run || run.principalId !== delegator.id || run.status !== "running") {
        return yield* reject("run_mismatch", "parent run must be a running run of the delegator")
      }

      const parent = input.parentGrantId ? read(input.parentGrantId) : undefined
      if (input.parentGrantId && !parent) return yield* reject("parent_missing", input.parentGrantId)
      if (parent) {
        if (parent.status !== "active" || parent.expires_at <= now) {
          return yield* reject("parent_inactive", `parent grant is ${parent.status}`)
        }
        if (parent.delegatee_principal_id !== delegator.id) {
          return yield* reject("delegator_mismatch", "only the holder of the parent grant may delegate under it")
        }
      }

      // INV-3.6: no principal appears twice in one chain.
      const chain = parent ? chainOf(parent.id) : []
      const principals = new Set<string>([delegator.id])
      for (const grant of chain) {
        principals.add(grant.delegatorPrincipalId)
        principals.add(grant.delegateePrincipalId)
      }
      if (principals.has(delegatee.id)) return yield* reject("cycle", "delegatee already appears in the chain")

      const depth = parent ? parent.depth + 1 : 1
      const maxDepth = effectiveMaxDepth(input.maxDepth)
      if (depth > maxDepth) return yield* reject("depth_exceeded", `depth ${depth} exceeds ${maxDepth}`)

      // INV-3.1: the grant may not let through what the delegator or the
      // parent grant denies. A parent grant is an allow-list, so what it does
      // not name counts as denied.
      const sources: [Permission.Ruleset, Lattice.Unmatched][] = [
        [delegator.capabilities, "neutral"],
        ...(parent ? [[parent.capabilities, "deny"] as [Permission.Ruleset, Lattice.Unmatched]] : []),
      ]
      for (const [source, unmatched] of sources) {
        const probe = Lattice.looserProbe(input.capabilities, source, unmatched)
        if (probe) return yield* reject("capability_escalation", `${probe.permission} ${probe.pattern}`)
      }

      // INV-3.2: scope ⊆ parent scope (or the runtime-provided root bound).
      const bound = parent ? parent.scope : input.bound
      if (!bound || !insideScope(input.scope, bound)) {
        return yield* reject("scope_escalation", "scope must be absolute paths inside the bound")
      }

      // INV-3.3: constraints may only be added.
      if (parent) {
        const missing = parent.constraints.find(
          (required) => !input.constraints.some((given) => sameConstraint(given, required)),
        )
        if (missing) return yield* reject("constraint_weakened", missing.kind)
      }

      // INV-3.4 and a live expiry.
      if (input.expiresAt <= now) return yield* reject("expired", "expiresAt is in the past")
      if (parent && input.expiresAt > parent.expires_at) return yield* reject("expiry_extended", "beyond parent expiry")

      // INV-3.5: policy revision never goes back.
      if (parent && input.policyRevision < parent.policy_revision) {
        return yield* reject("revision_regressed", `${input.policyRevision} < ${parent.policy_revision}`)
      }

      const row = Database.use((db) =>
        db
          .insert(DelegationGrantTable)
          .values({
            id: GrantID.ascending(),
            delegator_principal_id: delegator.id,
            delegatee_principal_id: delegatee.id,
            parent_grant_id: parent?.id ?? null,
            parent_run_id: input.parentRunId,
            capabilities: [...input.capabilities],
            scope: { paths: [...input.scope.paths] },
            constraints: [...input.constraints],
            expires_at: input.expiresAt,
            depth,
            policy_revision: input.policyRevision,
          })
          .returning()
          .get(),
      )
      Audit.record({
        eventType: "grant.issued",
        grantId: row.id,
        principalId: row.delegatee_principal_id,
        runId: row.parent_run_id,
        policyRevision: row.policy_revision,
      })
      return toGrant(row)
    })

    const get = Effect.fn("DelegationGrants.get")(function* (id: GrantID) {
      const row = read(id)
      return row ? toGrant(row) : undefined
    })

    const listByDelegatee = Effect.fn("DelegationGrants.listByDelegatee")(function* (principalId: PrincipalID) {
      const rows = Database.use((db) =>
        db
          .select()
          .from(DelegationGrantTable)
          .where(eq(DelegationGrantTable.delegatee_principal_id, principalId))
          .orderBy(asc(DelegationGrantTable.id))
          .all(),
      )
      return rows.map(toGrant)
    })

    const listChain = Effect.fn("DelegationGrants.listChain")(function* (id: GrantID) {
      return chainOf(id)
    })

    const expire = Effect.fn("DelegationGrants.expire")(function* (id: GrantID) {
      // Only an active grant expires; the event is recorded once.
      const changed = Database.use((db) =>
        db
          .update(DelegationGrantTable)
          .set({ status: "expired" })
          .where(and(eq(DelegationGrantTable.id, id), eq(DelegationGrantTable.status, "active")))
          .returning()
          .get(),
      )
      if (changed) {
        Audit.record({ eventType: "grant.expired", grantId: id, principalId: changed.delegatee_principal_id })
      }
    })

    return Service.of({ issue, get, listByDelegatee, listChain, expire })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Registry.defaultLayer))

export * as Grants from "./grants"
