import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { readFileSync, readdirSync } from "fs"
import path from "path"

const target = "20261108091000_session_inherited_permission"

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

describe("session inherited permission migration", () => {
  // SC-01: the inherited ceiling moved from process memory to a persisted
  // column. Upgrading an EXISTING database must add the column without
  // touching existing rows, and old delegated children (which have no recorded
  // ceiling) must be readable — the runtime fail-closes on them at read time.
  test("adds inherited_permission to an existing session table", () => {
    const entries = migrations()
    const index = entries.findIndex((entry) => entry.name === target)
    expect(index).toBeGreaterThan(0)

    const sqlite = new Database(":memory:")
    const db = drizzle({ client: sqlite })
    migrate(db, entries.slice(0, index))

    // A session row that existed BEFORE the ceiling column was introduced.
    sqlite.run(
      `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["ses_old_child", "project_1", "slug", "/tmp", "old child", "0.0.0", 1, 1],
    )

    expect(() => migrate(db, entries.slice(index))).not.toThrow()

    const row = sqlite.query("SELECT inherited_permission FROM session WHERE id = ?").get("ses_old_child") as
      | { inherited_permission: unknown }
      | null
    // Column exists; pre-existing rows have no ceiling (null) — the runtime
    // fail-closed logic turns this into deny-all for a delegated child.
    expect(row).not.toBeNull()
    expect(row!.inherited_permission).toBeNull()
  })
})
