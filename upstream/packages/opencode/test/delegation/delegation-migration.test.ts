import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { eq } from "drizzle-orm"
import { readFileSync, readdirSync } from "fs"
import path from "path"
import {
  AgentPrincipalTable,
  AgentRunTable,
  DelegationGrantTable,
  ExecutionAuditTable,
} from "../../src/delegation/delegation.sql"
import { GrantID, PrincipalID, RunID } from "../../src/delegation/schema"
import type { SessionID } from "../../src/session/schema"

const target = "20261109100000_delegation_runtime"

function migrations() {
  return readdirSync(path.join(import.meta.dirname, "../../migration"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      timestamp: Number(entry.name.split("_")[0]),
      sql: readFileSync(path.join(import.meta.dirname, "../../migration", entry.name, "migration.sql"), "utf-8"),
    }))
    .sort((a, b) => a.timestamp - b.timestamp)
}

function upgraded() {
  const entries = migrations()
  const index = entries.findIndex((entry) => entry.name === target)
  expect(index).toBeGreaterThan(0)
  const sqlite = new Database(":memory:")
  const db = drizzle({ client: sqlite })
  migrate(db, entries.slice(0, index))
  // A session that existed before Phase 4.
  sqlite.run(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["ses_before_phase4", "project_1", "slug", "/tmp", "before", "0.0.0", 1, 1],
  )
  migrate(db, entries.slice(index))
  return { sqlite, db }
}

describe("Phase 4 delegation runtime migration", () => {
  test("is the newest migration", () => {
    const entries = migrations()
    expect(entries.at(-1)?.name).toBe(target)
  })

  test("upgrading an existing database keeps session rows", () => {
    const { sqlite } = upgraded()
    const row = sqlite.query("SELECT id, title FROM session WHERE id = ?").get("ses_before_phase4")
    expect(row).toEqual({ id: "ses_before_phase4", title: "before" })
  })

  test("creates the four delegation tables", () => {
    const { sqlite } = upgraded()
    const names = (sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (row) => row.name,
    )
    expect(names).toEqual(
      expect.arrayContaining(["agent_principals", "agent_runs", "delegation_grants", "execution_audit"]),
    )
  })

  test("declared tables round-trip through the migrated schema", () => {
    const { db } = upgraded()
    const principal = PrincipalID.ascending()
    const child = PrincipalID.ascending()
    const run = RunID.ascending()
    const grant = GrantID.ascending()
    const rules = [{ permission: "read", pattern: "*", action: "allow" as const }]

    db.insert(AgentPrincipalTable)
      .values([
        { id: principal, owner_id: "human:local", definition: "build", role: "orchestrator", capabilities: rules, created_by: "runtime" },
        { id: child, owner_id: principal, definition: "general", role: "developer", capabilities: rules, created_by: "runtime" },
      ])
      .run()
    db.insert(AgentRunTable)
      .values({ id: run, principal_id: principal, session_id: "ses_before_phase4" as SessionID, policy_revision: 0 })
      .run()
    db.insert(DelegationGrantTable)
      .values({
        id: grant,
        delegator_principal_id: principal,
        delegatee_principal_id: child,
        parent_run_id: run,
        capabilities: rules,
        scope: { paths: ["/tmp/project"] },
        constraints: [],
        expires_at: 2_000_000_000_000,
        depth: 1,
        policy_revision: 0,
      })
      .run()
    db.insert(ExecutionAuditTable)
      .values({ event_type: "grant.issued", principal_id: principal, run_id: run, grant_id: grant, policy_revision: 0 })
      .run()

    const p = db.select().from(AgentPrincipalTable).where(eq(AgentPrincipalTable.id, principal)).get()
    expect(p?.status).toBe("active")
    expect(p?.capabilities).toEqual(rules)
    const r = db.select().from(AgentRunTable).where(eq(AgentRunTable.id, run)).get()
    expect(r?.status).toBe("running")
    expect(r?.parent_run_id).toBeNull()
    const g = db.select().from(DelegationGrantTable).where(eq(DelegationGrantTable.id, grant)).get()
    expect(g?.status).toBe("active")
    expect(g?.scope).toEqual({ paths: ["/tmp/project"] })
    const a = db.select().from(ExecutionAuditTable).all()
    expect(a).toHaveLength(1)
    expect(a[0].audit_id).toBeGreaterThan(0)
    expect(a[0].time_created).toBeGreaterThan(0)
  })

  test("ID types enforce their prefixes", () => {
    expect(PrincipalID.ascending().startsWith("apr")).toBe(true)
    expect(RunID.ascending().startsWith("run")).toBe(true)
    expect(GrantID.ascending().startsWith("grt")).toBe(true)
    expect(() => PrincipalID.make("ses_wrong")).toThrow()
  })

  test("audit rows have no column for prompt or argument text (AU-INV-3)", () => {
    const { sqlite } = upgraded()
    const columns = (sqlite.query("PRAGMA table_info(execution_audit)").all() as { name: string }[]).map((c) => c.name)
    for (const banned of ["prompt", "args", "input", "output", "text", "content"]) {
      expect(columns).not.toContain(banned)
    }
  })
})
