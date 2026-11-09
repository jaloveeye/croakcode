import { and, asc, eq, gte, lt, type SQL } from "drizzle-orm"
import * as Log from "@croakcode/core/util/log"
import type { SessionID } from "../session/schema"
import { Database } from "@/storage/db"
import { ExecutionAuditTable } from "./delegation.sql"
import type { GrantID, PrincipalID, RunID } from "./schema"

// Phase 4 Task 8 — execution audit (AU-INV-1..4).
//
// Plain functions over the audit table, so every delegation module can record
// without a service dependency. Records carry ids, decisions and the policy
// revision only: no prompt text, tool arguments or tool output (AU-INV-3).
// The table is separate from the usage log (AU-INV-4).
//
// Recording is best effort. A failed write is logged and does not stop the
// action: the authority decision itself already fails closed when state
// cannot be read, and an audit outage must not become an execution outage.

const log = Log.create({ service: "delegation.audit" })

/** Default retention (§8.3): 365 days. */
export const RETENTION_MS = 365 * 24 * 60 * 60 * 1000

export type EventType =
  | "principal.created"
  | "principal.revoked"
  | "grant.issued"
  | "grant.revoked"
  | "grant.expired"
  | "run.started"
  | "run.ended"
  | "run.aborted"
  | "tool.allowed"
  | "tool.denied"
  | "tool.asked"

export type Event = {
  readonly eventType: EventType
  readonly principalId?: PrincipalID
  readonly runId?: RunID
  readonly parentRunId?: RunID
  readonly sessionId?: SessionID
  readonly grantId?: GrantID
  readonly tool?: string
  readonly decision?: "allow" | "deny" | "ask"
  readonly errorCode?: string
  readonly policyRevision?: number
}

export type Record = Event & { readonly auditId: number; readonly timeCreated: number }

export function record(event: Event) {
  try {
    Database.use((db) =>
      db
        .insert(ExecutionAuditTable)
        .values({
          event_type: event.eventType,
          principal_id: event.principalId ?? null,
          run_id: event.runId ?? null,
          parent_run_id: event.parentRunId ?? null,
          session_id: event.sessionId ?? null,
          grant_id: event.grantId ?? null,
          tool: event.tool ?? null,
          decision: event.decision ?? null,
          error_code: event.errorCode ?? null,
          policy_revision: event.policyRevision ?? null,
        })
        .run(),
    )
  } catch (error) {
    log.warn("audit record failed", { eventType: event.eventType, error: String(error) })
  }
}

export type Filter = {
  readonly principalId?: PrincipalID
  readonly runId?: RunID
  readonly parentRunId?: RunID
  readonly sessionId?: SessionID
  readonly grantId?: GrantID
  readonly eventType?: EventType
  readonly since?: number
}

export function query(filter: Filter = {}): Record[] {
  const where: SQL[] = []
  if (filter.principalId) where.push(eq(ExecutionAuditTable.principal_id, filter.principalId))
  if (filter.runId) where.push(eq(ExecutionAuditTable.run_id, filter.runId))
  if (filter.parentRunId) where.push(eq(ExecutionAuditTable.parent_run_id, filter.parentRunId))
  if (filter.sessionId) where.push(eq(ExecutionAuditTable.session_id, filter.sessionId))
  if (filter.grantId) where.push(eq(ExecutionAuditTable.grant_id, filter.grantId))
  if (filter.eventType) where.push(eq(ExecutionAuditTable.event_type, filter.eventType))
  if (filter.since !== undefined) where.push(gte(ExecutionAuditTable.time_created, filter.since))
  const rows = Database.use((db) =>
    db
      .select()
      .from(ExecutionAuditTable)
      .where(where.length ? and(...where) : undefined)
      .orderBy(asc(ExecutionAuditTable.audit_id))
      .all(),
  )
  return rows.map((row) => ({
    auditId: row.audit_id,
    eventType: row.event_type as EventType,
    ...(row.principal_id ? { principalId: row.principal_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.grant_id ? { grantId: row.grant_id } : {}),
    ...(row.tool ? { tool: row.tool } : {}),
    ...(row.decision ? { decision: row.decision } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.policy_revision !== null ? { policyRevision: row.policy_revision } : {}),
    timeCreated: row.time_created,
  }))
}

/**
 * The permission engine's part of AU-03. `asked` is recorded when the
 * engine's own rules decide "ask" for any pattern, before the user is
 * prompted; an approval stored earlier may still answer without a prompt.
 */
export function engineAsked(sessionId: SessionID, tool: string, asks: boolean) {
  if (asks) record({ eventType: "tool.asked", sessionId, tool, decision: "ask" })
}

/** The engine refused: a deny rule, or the user rejected or corrected the call. */
export function engineDenied(sessionId: SessionID, tool: string, tag: string) {
  record({ eventType: "tool.denied", sessionId, tool, decision: "deny", errorCode: tag })
}

/** Deletes records older than the retention window; returns how many. */
export function prune(now = Date.now(), retentionMs = RETENTION_MS) {
  return Database.use((db) =>
    db
      .delete(ExecutionAuditTable)
      .where(lt(ExecutionAuditTable.time_created, now - retentionMs))
      .returning({ id: ExecutionAuditTable.audit_id })
      .all(),
  ).length
}

/** How often pruneIfDue deletes old records. */
export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

let lastPrune: number | undefined

/**
 * Prunes at most once per PRUNE_INTERVAL_MS per process. The guard calls it
 * when a run begins, so a long-running server still prunes daily. Best
 * effort: a failure is logged and retried on the next interval.
 */
export function pruneIfDue(now = Date.now()) {
  if (lastPrune !== undefined && now - lastPrune < PRUNE_INTERVAL_MS) return undefined
  lastPrune = now
  try {
    const removed = prune(now)
    if (removed > 0) log.info("pruned audit records", { removed })
    return removed
  } catch (error) {
    log.warn("audit prune failed", { error: error instanceof Error ? error.message : String(error) })
    return undefined
  }
}

/** Test hook: the next pruneIfDue runs regardless of the interval. */
export function resetPruneClock() {
  lastPrune = undefined
}

export * as Audit from "./audit"
