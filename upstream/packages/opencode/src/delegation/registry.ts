import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import type { Permission } from "../permission"
import type { SessionID } from "../session/schema"
import { Database } from "@/storage/db"
import { AgentPrincipalTable, AgentRunTable } from "./delegation.sql"
import { Audit } from "./audit"
import {
  GrantID,
  HUMAN_LOCAL,
  PrincipalID,
  RunID,
  type PrincipalStatus,
  type RunStatus,
} from "./schema"

// Phase 4 Task 2 — Agent Registry and Run store.
//
// Identity is issued here and nowhere else (INV-5.3). Callers pass the
// definition, owner and role from trusted runtime state; no input field is
// read from model output, and the id is always generated here.

export type Principal = {
  readonly id: PrincipalID
  readonly ownerId: string
  readonly definition: string
  readonly role: string
  readonly status: PrincipalStatus
  readonly capabilities: Permission.Ruleset
  readonly createdBy: string
  readonly revokedReason?: string
  readonly timeRevoked?: number
  readonly timeCreated: number
}

export type Run = {
  readonly id: RunID
  readonly principalId: PrincipalID
  readonly sessionId: SessionID
  readonly parentRunId?: RunID
  readonly grantId?: GrantID
  readonly policyRevision: number
  readonly status: RunStatus
  readonly timeEnded?: number
  readonly timeCreated: number
}

export class PrincipalNotFoundError extends Schema.TaggedErrorClass<PrincipalNotFoundError>()(
  "DelegationPrincipalNotFoundError",
  { principalId: Schema.String },
) {
  override get message() {
    return `Agent principal not found: ${this.principalId}`
  }
}

export class PrincipalRevokedError extends Schema.TaggedErrorClass<PrincipalRevokedError>()(
  "DelegationPrincipalRevokedError",
  { principalId: Schema.String },
) {
  override get message() {
    return `Agent principal is revoked: ${this.principalId}`
  }
}

export class InvalidOwnerError extends Schema.TaggedErrorClass<InvalidOwnerError>()("DelegationInvalidOwnerError", {
  ownerId: Schema.String,
}) {
  override get message() {
    return `Owner must be ${HUMAN_LOCAL} or an agent principal id: ${this.ownerId}`
  }
}

export class RunNotFoundError extends Schema.TaggedErrorClass<RunNotFoundError>()("DelegationRunNotFoundError", {
  runId: Schema.String,
}) {
  override get message() {
    return `Agent run not found: ${this.runId}`
  }
}

export type IssueError = PrincipalNotFoundError | PrincipalRevokedError | InvalidOwnerError
export type StartRunError = PrincipalNotFoundError | PrincipalRevokedError | RunNotFoundError

export interface Interface {
  readonly issuePrincipal: (input: {
    readonly ownerId: string
    readonly definition: string
    readonly role: string
    readonly capabilities: Permission.Ruleset
  }) => Effect.Effect<Principal, IssueError>
  readonly getPrincipal: (id: PrincipalID) => Effect.Effect<Principal | undefined>
  readonly listByOwner: (ownerId: string) => Effect.Effect<Principal[]>
  /** Marks the principal revoked. Grant cascade and run abort are Task 7. */
  readonly revokePrincipal: (id: PrincipalID, reason: string) => Effect.Effect<void, PrincipalNotFoundError>
  readonly startRun: (input: {
    readonly principalId: PrincipalID
    readonly sessionId: SessionID
    readonly parentRunId?: RunID
    readonly grantId?: GrantID
    readonly policyRevision: number
  }) => Effect.Effect<Run, StartRunError>
  readonly endRun: (id: RunID, status: Exclude<RunStatus, "running">) => Effect.Effect<void>
  readonly getRun: (id: RunID) => Effect.Effect<Run | undefined>
  readonly activeRun: (sessionId: SessionID) => Effect.Effect<Run | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@croakcode/DelegationRegistry") {}

type PrincipalRow = typeof AgentPrincipalTable.$inferSelect
type RunRow = typeof AgentRunTable.$inferSelect

function toPrincipal(row: PrincipalRow): Principal {
  return {
    id: row.id,
    ownerId: row.owner_id,
    definition: row.definition,
    role: row.role,
    status: row.status,
    capabilities: row.capabilities,
    createdBy: row.created_by,
    ...(row.revoked_reason != null ? { revokedReason: row.revoked_reason } : {}),
    ...(row.time_revoked != null ? { timeRevoked: row.time_revoked } : {}),
    timeCreated: row.time_created,
  }
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    principalId: row.principal_id,
    sessionId: row.session_id,
    ...(row.parent_run_id != null ? { parentRunId: row.parent_run_id } : {}),
    ...(row.grant_id != null ? { grantId: row.grant_id } : {}),
    policyRevision: row.policy_revision,
    status: row.status,
    ...(row.time_ended != null ? { timeEnded: row.time_ended } : {}),
    timeCreated: row.time_created,
  }
}

const isPrincipalId = Schema.is(PrincipalID)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const readPrincipal = (id: PrincipalID) =>
      Database.use((db) => db.select().from(AgentPrincipalTable).where(eq(AgentPrincipalTable.id, id)).get())

    const requireActive = Effect.fnUntraced(function* (id: PrincipalID) {
      const row = readPrincipal(id)
      if (!row) return yield* new PrincipalNotFoundError({ principalId: id })
      if (row.status !== "active") return yield* new PrincipalRevokedError({ principalId: id })
      return row
    })

    const issuePrincipal = Effect.fn("DelegationRegistry.issuePrincipal")(function* (input: {
      readonly ownerId: string
      readonly definition: string
      readonly role: string
      readonly capabilities: Permission.Ruleset
    }) {
      if (input.ownerId !== HUMAN_LOCAL) {
        if (!isPrincipalId(input.ownerId)) return yield* new InvalidOwnerError({ ownerId: input.ownerId })
        yield* requireActive(input.ownerId)
      }
      const row = Database.use((db) =>
        db
          .insert(AgentPrincipalTable)
          .values({
            id: PrincipalID.ascending(),
            owner_id: input.ownerId,
            definition: input.definition,
            role: input.role,
            capabilities: [...input.capabilities],
            created_by: "runtime",
          })
          .returning()
          .get(),
      )
      Audit.record({ eventType: "principal.created", principalId: row.id })
      return toPrincipal(row)
    })

    const getPrincipal = Effect.fn("DelegationRegistry.getPrincipal")(function* (id: PrincipalID) {
      const row = readPrincipal(id)
      return row ? toPrincipal(row) : undefined
    })

    const listByOwner = Effect.fn("DelegationRegistry.listByOwner")(function* (ownerId: string) {
      const rows = Database.use((db) =>
        db
          .select()
          .from(AgentPrincipalTable)
          .where(eq(AgentPrincipalTable.owner_id, ownerId))
          .orderBy(asc(AgentPrincipalTable.id))
          .all(),
      )
      return rows.map(toPrincipal)
    })

    const revokePrincipal = Effect.fn("DelegationRegistry.revokePrincipal")(function* (
      id: PrincipalID,
      reason: string,
    ) {
      const row = readPrincipal(id)
      if (!row) return yield* new PrincipalNotFoundError({ principalId: id })
      if (row.status === "revoked") return
      Database.use((db) =>
        db
          .update(AgentPrincipalTable)
          .set({ status: "revoked", revoked_reason: reason, time_revoked: Date.now() })
          .where(eq(AgentPrincipalTable.id, id))
          .run(),
      )
      Audit.record({ eventType: "principal.revoked", principalId: id })
    })

    const startRun = Effect.fn("DelegationRegistry.startRun")(function* (input: {
      readonly principalId: PrincipalID
      readonly sessionId: SessionID
      readonly parentRunId?: RunID
      readonly grantId?: GrantID
      readonly policyRevision: number
    }) {
      yield* requireActive(input.principalId)
      if (input.parentRunId) {
        const parent = Database.use((db) =>
          db.select().from(AgentRunTable).where(eq(AgentRunTable.id, input.parentRunId!)).get(),
        )
        if (!parent) return yield* new RunNotFoundError({ runId: input.parentRunId })
      }
      const { row, closed } = Database.transaction((db) => {
        // INV-2.4: one active run per session. A new run closes the previous
        // one as aborted; it did not reach a recorded end.
        const closed = db
          .update(AgentRunTable)
          .set({ status: "aborted", time_ended: Date.now() })
          .where(and(eq(AgentRunTable.session_id, input.sessionId), eq(AgentRunTable.status, "running")))
          .returning()
          .all()
        const row = db
          .insert(AgentRunTable)
          .values({
            id: RunID.ascending(),
            principal_id: input.principalId,
            session_id: input.sessionId,
            parent_run_id: input.parentRunId ?? null,
            grant_id: input.grantId ?? null,
            policy_revision: input.policyRevision,
          })
          .returning()
          .get()
        return { row, closed }
      })
      for (const old of closed) {
        Audit.record({ eventType: "run.aborted", runId: old.id, principalId: old.principal_id, sessionId: old.session_id })
      }
      // AU-02: the typed parent/child run link is recorded with every start.
      Audit.record({
        eventType: "run.started",
        runId: row.id,
        principalId: row.principal_id,
        sessionId: row.session_id,
        ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
        ...(row.grant_id ? { grantId: row.grant_id } : {}),
        policyRevision: row.policy_revision,
      })
      return toRun(row)
    })

    const endRun = Effect.fn("DelegationRegistry.endRun")(function* (
      id: RunID,
      status: Exclude<RunStatus, "running">,
    ) {
      // Only a running run changes; a finished run keeps its first outcome.
      const ended = Database.use((db) =>
        db
          .update(AgentRunTable)
          .set({ status, time_ended: Date.now() })
          .where(and(eq(AgentRunTable.id, id), eq(AgentRunTable.status, "running")))
          .returning()
          .get(),
      )
      if (ended) {
        Audit.record({
          eventType: status === "completed" ? "run.ended" : "run.aborted",
          runId: ended.id,
          principalId: ended.principal_id,
          sessionId: ended.session_id,
          ...(ended.parent_run_id ? { parentRunId: ended.parent_run_id } : {}),
        })
      }
    })

    const getRun = Effect.fn("DelegationRegistry.getRun")(function* (id: RunID) {
      const row = Database.use((db) => db.select().from(AgentRunTable).where(eq(AgentRunTable.id, id)).get())
      return row ? toRun(row) : undefined
    })

    const activeRun = Effect.fn("DelegationRegistry.activeRun")(function* (sessionId: SessionID) {
      const row = Database.use((db) =>
        db
          .select()
          .from(AgentRunTable)
          .where(and(eq(AgentRunTable.session_id, sessionId), eq(AgentRunTable.status, "running")))
          .get(),
      )
      return row ? toRun(row) : undefined
    })

    return Service.of({
      issuePrincipal,
      getPrincipal,
      listByOwner,
      revokePrincipal,
      startRun,
      endRun,
      getRun,
      activeRun,
    })
  }),
)

export const defaultLayer = layer

export * as Registry from "./registry"
