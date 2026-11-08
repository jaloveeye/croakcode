import test from "node:test";
import assert from "node:assert/strict";
import { resolveHarnessInclusion, HARNESS_DECISIONS, HARNESS_REFRESH_TRIGGERS, HARNESS_EVENT } from "@croakcode/contracts";

test("allow/ask include, deny excludes", () => {
  assert.equal(resolveHarnessInclusion("allow"), "include");
  assert.equal(resolveHarnessInclusion("ask"), "include_requires_approval");
  assert.equal(resolveHarnessInclusion("deny"), "exclude");
  assert.equal(resolveHarnessInclusion("not_applicable"), "exclude");
});

test("unknown decision fails closed to exclude", () => {
  assert.equal(resolveHarnessInclusion(undefined), "exclude");
  assert.equal(resolveHarnessInclusion("typo"), "exclude");
  assert.equal(resolveHarnessInclusion(null), "exclude");
});

test("harness contract declares decisions, triggers, and event", () => {
  assert.deepEqual(HARNESS_DECISIONS, ["allow", "ask", "deny", "not_applicable"]);
  assert.ok(HARNESS_REFRESH_TRIGGERS.includes("connection_mode_switch"));
  assert.ok(HARNESS_REFRESH_TRIGGERS.includes("subagent_spawn"));
  assert.equal(HARNESS_EVENT.name, "harness.updated");
  assert.equal(HARNESS_EVENT.snapshot, true);
});

test("runtime-wired triggers are a declared subset of all triggers", () => {
  const RUNTIME_WIRED = ["turn_start", "permission_reply", "permission_profile_change", "subagent_spawn"];
  const DEFERRED = ["session_start", "connection_mode_switch"];
  for (const t of [...RUNTIME_WIRED, ...DEFERRED]) assert.ok(HARNESS_REFRESH_TRIGGERS.includes(t));
  assert.equal(RUNTIME_WIRED.length + DEFERRED.length, HARNESS_REFRESH_TRIGGERS.length);
});
