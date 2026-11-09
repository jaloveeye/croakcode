import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { queryOne } from "./sqlite-helper.mjs";

const HOME = process.env.CROAKCODE_TEST_HOME ?? "/tmp/croakcode-phase1-home";
const DB = path.join(HOME, ".local/share/croakcode/croakcode.db");
const SESSION_JSON = "/tmp/croakcode-session.json";

test("created session row is persisted in croakcode.db", () => {
  assert.ok(existsSync(DB), `db missing: ${DB} (run scripts/phase1-headless-check.sh first)`);
  assert.ok(existsSync(SESSION_JSON), "session json missing (run headless script first)");
  const { id } = JSON.parse(readFileSync(SESSION_JSON, "utf8"));
  assert.ok(id, "session id empty");
  const { count } = queryOne(DB, "SELECT count(*) AS count FROM session WHERE id = ?", id);
  assert.equal(count, 1, `session ${id} not persisted`);
});
