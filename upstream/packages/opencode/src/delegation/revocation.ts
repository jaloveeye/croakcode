import { and, eq, inArray } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import type { SessionID } from "../session/schema"
import { Database } from "@/storage/db"
import { AgentRunTable, DelegationGrantTable } from "./delegation.sql"
import { Registry } from "./registry"
import type { GrantID, PrincipalID, RunID } from "./schema"

// Phase 4 Task 7 — revocation cascade (INV-6.1..6.3).
//
// Revoking a grant revokes every grant below it in one transaction and closes
// the runs started under any of them. Revoking a principal revokes it, every
// grant it issued or holds (with their subtrees), and closes its runs.
//
// The service only changes the database. The sessions of the closed runs are
// returned so the caller can cancel what is in flight; the next tool call in
// those sessions is denied either way, because the execution-time check reads
// the run and the grant chain again.

export type AbortedRun = { readonly runId: RunID; readonly sessionId: SessionID }

export type Result = {
  /** Grants this call changed to revoked (already revoked or expired ones are not listed). */
  readonly revokedGrants: GrantID[]
  /** Runs this call closed as aborted. */
  readonly abortedRuns: AbortedRun[]
}

export class GrantNotFoundError extends Schema.TaggedErrorClass<GrantNotFoundError>()(
  "DelegationGrantNotFoundError",
  { grantId: Schema.String },
) {
  override get message() {
    return `Delegation grant not found: ${this.grantId}`
  }
}

export interface Interface {
  readonly revokeGrant: (id: GrantID, reason: string) => Effect.Effect<Result, GrantNotFoundError>
  readonly revokePrincipal: (
    id: PrincipalID,
    reason: string,
  ) => Effect.Effect<Result, Registry.PrincipalNotFoundError>
  readonly isRevoked: (id: GrantID) => Effect.Effect<boolean>
  readonly isPrincipalRevoked: (id: PrincipalID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@croakcode/DelegationRevocation") {}

type Tx = Parameters<Parameters<typeof Database.transaction>[0]>[0]

/** The grant and every grant below it (breadth-first, each id once). */
function subtree(db: Tx, roots: readonly GrantID[]): GrantID[] {
  const seen = new Set<GrantID>()
  let frontier = [...roots]
  while (frontier.length > 0) {
    for (const id of frontier) seen.add(id)
    const children = db
      .select({ id: DelegationGrantTable.id })
      .from(DelegationGrantTable)
      .where(inArray(DelegationGrantTable.parent_grant_id, frontier))
      .all()
      .map((row) => row.id)
      .filter((id) => !seen.has(id))
    frontier = children
  }
  return [...seen]
}

/** Revokes the active grants among `ids` and closes runs started under any of them. */
function revokeAll(db: Tx, ids: readonly GrantID[], reason: string, extraRuns: readonly RunID[] = []): Result {
  const now = Date.now()
  const changed =
    ids.length === 0
      ? []
      : db
          .update(DelegationGrantTable)
          .set({ status: "revoked", revoked_reason: reason, time_revoked: now })
          .where(and(inArray(DelegationGrantTable.id, [...ids]), eq(DelegationGrantTable.status, "active")))
          .returning({ id: DelegationGrantTable.id })
          .all()
          .map((row) => row.id)
  const running = db
    .select({ id: AgentRunTable.id, session: AgentRunTable.session_id, grant: AgentRunTable.grant_id })
    .from(AgentRunTable)
    .where(eq(AgentRunTable.status, "running"))
    .all()
    .filter((row) => (row.grant && ids.includes(row.grant)) || extraRuns.includes(row.id))
  if (running.length > 0) {
    db.update(AgentRunTable)
      .set({ status: "aborted", time_ended: now })
      .where(inArray(AgentRunTable.id, running.map((row) => row.id)))
      .run()
  }
  return { revokedGrants: changed, abortedRuns: running.map((row) => ({ runId: row.id, sessionId: row.session })) }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* Registry.Service

    const revokeGrant = Effect.fn("DelegationRevocation.revokeGrant")(function* (id: GrantID, reason: string) {
      const exists = Database.use((db) =>
        db.select({ id: DelegationGrantTable.id }).from(DelegationGrantTable).where(eq(DelegationGrantTable.id, id)).get(),
      )
      if (!exists) return yield* new GrantNotFoundError({ grantId: id })
      // TODO(Phase 4 Task 8): record grant.revoked and run.aborted audit events.
      return Database.transaction((db) => revokeAll(db, subtree(db, [id]), reason))
    })

    const revokePrincipal = Effect.fn("DelegationRevocation.revokePrincipal")(function* (
      id: PrincipalID,
      reason: string,
    ) {
      yield* registry.revokePrincipal(id, reason)
      return Database.transaction((db) => {
        const related = db
          .select({ id: DelegationGrantTable.id })
          .from(DelegationGrantTable)
          .where(eq(DelegationGrantTable.delegator_principal_id, id))
          .all()
          .concat(
            db
              .select({ id: DelegationGrantTable.id })
              .from(DelegationGrantTable)
              .where(eq(DelegationGrantTable.delegatee_principal_id, id))
              .all(),
          )
          .map((row) => row.id)
        const own = db
          .select({ id: AgentRunTable.id })
          .from(AgentRunTable)
          .where(and(eq(AgentRunTable.principal_id, id), eq(AgentRunTable.status, "running")))
          .all()
          .map((row) => row.id)
        return revokeAll(db, subtree(db, related), reason, own)
      })
    })

    const isRevoked = Effect.fn("DelegationRevocation.isRevoked")(function* (id: GrantID) {
      const row = Database.use((db) =>
        db
          .select({ status: DelegationGrantTable.status })
          .from(DelegationGrantTable)
          .where(eq(DelegationGrantTable.id, id))
          .get(),
      )
      return row?.status === "revoked"
    })

    const isPrincipalRevoked = Effect.fn("DelegationRevocation.isPrincipalRevoked")(function* (id: PrincipalID) {
      return (yield* registry.getPrincipal(id))?.status === "revoked"
    })

    return Service.of({ revokeGrant, revokePrincipal, isRevoked, isPrincipalRevoked })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Registry.defaultLayer))

export * as Revocation from "./revocation"
