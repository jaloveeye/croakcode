import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const HOME = process.env.CROAKCODE_TEST_HOME ?? "/tmp/croakcode-phase1-home";
const DB = path.join(HOME, ".local/share/croakcode/croakcode.db");

function pragma(query) {
  return execFileSync("sqlite3", [DB, query], { encoding: "utf8" }).trim();
}

// journal_mode는 파일에 영속된다 — 실제 DB 파일에서 직접 확인한다.
test("croakcode.db uses WAL journal mode on disk", () => {
  assert.ok(existsSync(DB), `db missing: ${DB} (run scripts/phase1-headless-check.sh first)`);
  assert.equal(pragma("PRAGMA journal_mode;").toLowerCase(), "wal");
});

// busy_timeout/foreign_keys 는 연결별(per-connection)이라 새 sqlite3 프로세스로는 검증할 수 없다.
// 대신 소스에서 설정되었는지 확인한다.
test("db.ts configures busy_timeout, foreign_keys, and WAL in source", () => {
  const src = readFileSync(
    path.resolve(import.meta.dirname, "../upstream/packages/opencode/src/storage/db.ts"),
    "utf8",
  );
  assert.match(src, /busy_timeout/i, "busy_timeout pragma not configured");
  assert.match(src, /foreign_keys/i, "foreign_keys pragma not configured");
  assert.match(src, /journal_mode/i, "journal_mode pragma not configured");
});
