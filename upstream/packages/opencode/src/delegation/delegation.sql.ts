import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { Permission } from "../permission"
import type { SessionID } from "../session/schema"
import { Timestamps } from "../storage/schema.sql"
import type {
  GrantConstraint,
  GrantID,
  GrantScope,
  GrantStatus,
  PrincipalID,
  PrincipalStatus,
  RunID,
  RunStatus,
} from "./schema"

// Phase 4 delegation runtime tables. They carry no foreign keys to session
// tables: deleting a session must not delete its audit trail or the grants
// that authorized it. Capabilities reuse the permission Ruleset shape so the
// existing evaluate() applies to every layer.

export const AgentPrincipalTable = sqliteTable(
  "agent_principals",
  {
    id: text().$type<PrincipalID>().primaryKey(),
    // A parent principal id, or HUMAN_LOCAL for a root principal.
    owner_id: text().notNull(),
    // The agent definition (template) this principal was issued from.
    definition: text().notNull(),
    role: text().notNull(),
    status: text().$type<PrincipalStatus>().notNull().default("active"),
    capabilities: text({ mode: "json" }).$type<Permission.Ruleset>().notNull(),
    created_by: text().notNull(),
    revoked_reason: text(),
    time_revoked: integer(),
    ...Timestamps,
  },
  (table) => [index("agent_principals_owner_idx").on(table.owner_id)],
)

export const AgentRunTable = sqliteTable(
  "agent_runs",
  {
    id: text().$type<RunID>().primaryKey(),
    principal_id: text().$type<PrincipalID>().notNull(),
    session_id: text().$type<SessionID>().notNull(),
    parent_run_id: text().$type<RunID>(),
    grant_id: text().$type<GrantID>(),
    policy_revision: integer().notNull(),
    status: text().$type<RunStatus>().notNull().default("running"),
    time_ended: integer(),
    ...Timestamps,
  },
  (table) => [
    index("agent_runs_principal_idx").on(table.principal_id),
    index("agent_runs_session_idx").on(table.session_id),
    index("agent_runs_parent_idx").on(table.parent_run_id),
  ],
)

export const DelegationGrantTable = sqliteTable(
  "delegation_grants",
  {
    id: text().$type<GrantID>().primaryKey(),
    delegator_principal_id: text().$type<PrincipalID>().notNull(),
    delegatee_principal_id: text().$type<PrincipalID>().notNull(),
    parent_grant_id: text().$type<GrantID>(),
    parent_run_id: text().$type<RunID>().notNull(),
    capabilities: text({ mode: "json" }).$type<Permission.Ruleset>().notNull(),
    scope: text({ mode: "json" }).$type<GrantScope>().notNull(),
    constraints: text({ mode: "json" }).$type<GrantConstraint[]>().notNull(),
    expires_at: integer().notNull(),
    status: text().$type<GrantStatus>().notNull().default("active"),
    // 1 for a grant issued by a root principal; at most 3 (Phase 4 decision 7).
    depth: integer().notNull(),
    policy_revision: integer().notNull(),
    revoked_reason: text(),
    time_revoked: integer(),
    ...Timestamps,
  },
  (table) => [
    index("delegation_grants_delegatee_idx").on(table.delegatee_principal_id),
    index("delegation_grants_parent_idx").on(table.parent_grant_id),
    index("delegation_grants_parent_run_idx").on(table.parent_run_id),
  ],
)

// AU-INV-3: no column holds prompt text, tool arguments or tool output.
export const ExecutionAuditTable = sqliteTable(
  "execution_audit",
  {
    audit_id: integer().primaryKey({ autoIncrement: true }),
    event_type: text().notNull(),
    principal_id: text().$type<PrincipalID>(),
    run_id: text().$type<RunID>(),
    parent_run_id: text().$type<RunID>(),
    session_id: text().$type<SessionID>(),
    grant_id: text().$type<GrantID>(),
    tool: text(),
    decision: text().$type<"allow" | "deny" | "ask">(),
    error_code: text(),
    policy_revision: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("execution_audit_principal_idx").on(table.principal_id),
    index("execution_audit_run_idx").on(table.run_id),
    index("execution_audit_parent_run_idx").on(table.parent_run_id),
  ],
)
