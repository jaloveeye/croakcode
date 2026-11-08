import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NET_TOOLS, normalizePolicy, deniedFor, isDenied, readPolicy, writePolicy,
} from "../upstream/.croakcode/plugins/lib/policy-state.js";

test("normalizePolicy trims, dedupes and drops non-strings", () => {
  const p = normalizePolicy({ deny: [" websearch ", "websearch", 3, ""], sessions: { s1: ["webfetch", "webfetch"] } });
  assert.deepEqual(p, { deny: ["websearch"], sessions: { s1: ["webfetch"] } });
  assert.deepEqual(normalizePolicy(null), { deny: [], sessions: {} });
});

test("deniedFor merges global and session rules", () => {
  const p = { deny: ["websearch"], sessions: { s1: ["bash"] } };
  assert.deepEqual([...deniedFor(p, "s1")].sort(), ["bash", "websearch"]);
  assert.deepEqual([...deniedFor(p)], ["websearch"]);
});

test("isDenied matches exact and prefix wildcards", () => {
  assert.equal(isDenied({ deny: ["rhwp_*"] }, undefined, "rhwp_read"), true);
  assert.equal(isDenied({ deny: ["*"] }, undefined, "anything"), true);
  assert.equal(isDenied({ deny: ["bash"] }, undefined, "bash"), true);
  assert.equal(isDenied({ deny: ["bash"] }, undefined, "grep"), false);
});

test("writePolicy roundtrips atomically and readPolicy returns ENOENT as empty", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "policy-"));
  const file = path.join(dir, "tool-policy.json");
  assert.deepEqual(await readPolicy(file), { deny: [], sessions: {} });
  await writePolicy({ deny: ["webfetch"] }, file);
  assert.deepEqual(await readPolicy(file), { deny: ["webfetch"], sessions: {} });
  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.ok(raw.updatedAt);
  assert.deepEqual(NET_TOOLS, ["websearch", "webfetch"]);
});
