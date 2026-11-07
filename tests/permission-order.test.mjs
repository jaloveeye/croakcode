import test from "node:test";
import assert from "node:assert/strict";
import { resolveExecutionPlan } from "@croakcode/control";

const base = { tool: "bash", sessionID: "s1", args: {} };

// --- Positive (gate) ---

test("1. plugin deny short-circuits before policy/permission", () => {
  const p = resolveExecutionPlan({ ...base, mode: "gate", plugin: "deny", policy: "allow", permission: "allow" });
  assert.equal(p.stage, "plugin");
  assert.equal(p.execute, false);
  assert.equal(p.askUser, false);
  assert.equal(p.errorCode, "PLUGIN_DENIED");
});

test("2. policy deny beats permission allow", () => {
  const p = resolveExecutionPlan({ ...base, mode: "gate", plugin: "allow", policy: "deny", permission: "allow" });
  assert.equal(p.stage, "policy");
  assert.equal(p.execute, false);
  assert.equal(p.askUser, false);
  assert.equal(p.errorCode, "POLICY_DENIED");
});

test("3. plugin ask + policy deny => deny wins, never asks", () => {
  const p = resolveExecutionPlan({ ...base, mode: "gate", plugin: "ask", policy: "deny", permission: "allow" });
  assert.equal(p.stage, "policy");
  assert.equal(p.execute, false);
  assert.equal(p.askUser, false);
  assert.equal(p.errorCode, "POLICY_DENIED");
});

test("4. policy checked before permission ask", () => {
  const p = resolveExecutionPlan({ ...base, mode: "gate", plugin: "allow", policy: "allow", permission: "ask" });
  assert.equal(p.stage, "permission");
  assert.equal(p.askUser, true);
  assert.equal(p.execute, false);
  assert.equal(p.errorCode, undefined);
});

test("5. plugin ask with all denies cleared surfaces at permission stage for approval", () => {
  const p = resolveExecutionPlan({ ...base, mode: "gate", plugin: "ask", policy: "allow", permission: "allow" });
  assert.equal(p.stage, "permission");
  assert.equal(p.askUser, true);
  assert.equal(p.execute, false);
  assert.equal(p.errorCode, undefined);
});

test("6. all allow (gate, policy allow) executes", () => {
  const p = resolveExecutionPlan({ ...base, mode: "gate", plugin: "allow", policy: "allow", permission: "allow" });
  assert.equal(p.stage, "execute");
  assert.equal(p.execute, true);
  assert.equal(p.askUser, false);
  assert.equal(p.errorCode, undefined);
});

// --- Negative / mode branches ---

test("7. missing mode (undefined) => validate INVALID_INPUT", () => {
  const p = resolveExecutionPlan({ ...base, plugin: "allow", policy: "allow", permission: "allow" });
  assert.equal(p.stage, "validate");
  assert.equal(p.execute, false);
  assert.equal(p.askUser, false);
  assert.equal(p.errorCode, "INVALID_INPUT");
});

test("8. invalid mode ('proxy') => validate INVALID_INPUT", () => {
  const p = resolveExecutionPlan({ ...base, mode: "proxy", plugin: "allow", policy: "allow", permission: "allow" });
  assert.equal(p.stage, "validate");
  assert.equal(p.execute, false);
  assert.equal(p.askUser, false);
  assert.equal(p.errorCode, "INVALID_INPUT");
});

test("9. plugin undefined => validate INVALID_DECISION naming plugin", () => {
  const p = resolveExecutionPlan({ ...base, mode: "gate", policy: "allow", permission: "allow" });
  assert.equal(p.stage, "validate");
  assert.equal(p.execute, false);
  assert.equal(p.askUser, false);
  assert.equal(p.errorCode, "INVALID_DECISION");
  assert.match(p.denyReason, /plugin/);
});

test("10. permission undefined => validate INVALID_DECISION", () => {
  const p = resolveExecutionPlan({ ...base, mode: "gate", plugin: "allow", policy: "allow" });
  assert.equal(p.stage, "validate");
  assert.equal(p.execute, false);
  assert.equal(p.askUser, false);
  assert.equal(p.errorCode, "INVALID_DECISION");
  assert.match(p.denyReason, /permission/);
});

test("11. policy undefined (mode gate) => validate INVALID_DECISION", () => {
  const p = resolveExecutionPlan({ ...base, mode: "gate", plugin: "allow", permission: "allow" });
  assert.equal(p.stage, "validate");
  assert.equal(p.execute, false);
  assert.equal(p.askUser, false);
  assert.equal(p.errorCode, "INVALID_DECISION");
  assert.match(p.denyReason, /policy/);
});

test("12. permission 'blocked' (unknown) => validate INVALID_DECISION", () => {
  const p = resolveExecutionPlan({ ...base, mode: "gate", plugin: "allow", policy: "allow", permission: "blocked" });
  assert.equal(p.stage, "validate");
  assert.equal(p.execute, false);
  assert.equal(p.askUser, false);
  assert.equal(p.errorCode, "INVALID_DECISION");
  assert.match(p.denyReason, /permission/);
});

test("13. policy 'ask' => validate INVALID_DECISION", () => {
  const p = resolveExecutionPlan({ ...base, mode: "gate", plugin: "allow", policy: "ask", permission: "allow" });
  assert.equal(p.stage, "validate");
  assert.equal(p.execute, false);
  assert.equal(p.askUser, false);
  assert.equal(p.errorCode, "INVALID_DECISION");
  assert.match(p.denyReason, /policy/);
});

test("14. gate + policy 'not_applicable' => POLICY_UNAVAILABLE, no execute", () => {
  const p = resolveExecutionPlan({ ...base, mode: "gate", plugin: "allow", policy: "not_applicable", permission: "allow" });
  assert.equal(p.stage, "policy");
  assert.equal(p.execute, false);
  assert.equal(p.askUser, false);
  assert.equal(p.errorCode, "POLICY_UNAVAILABLE");
});

test("15. direct + policy 'not_applicable' + others allow => executes", () => {
  const p = resolveExecutionPlan({ ...base, mode: "direct", plugin: "allow", policy: "not_applicable", permission: "allow" });
  assert.equal(p.stage, "execute");
  assert.equal(p.execute, true);
  assert.equal(p.askUser, false);
});

test("16. direct + policy 'deny' => POLICY_DENIED", () => {
  const p = resolveExecutionPlan({ ...base, mode: "direct", plugin: "allow", policy: "deny", permission: "allow" });
  assert.equal(p.stage, "policy");
  assert.equal(p.execute, false);
  assert.equal(p.askUser, false);
  assert.equal(p.errorCode, "POLICY_DENIED");
});

test("17. direct + policy 'allow' + others allow => executes", () => {
  const p = resolveExecutionPlan({ ...base, mode: "direct", plugin: "allow", policy: "allow", permission: "allow" });
  assert.equal(p.stage, "execute");
  assert.equal(p.execute, true);
  assert.equal(p.askUser, false);
});

test("18. gate + policy 'allow' + permission 'ask' => permission stage, askUser true, no execute", () => {
  const p = resolveExecutionPlan({ ...base, mode: "gate", plugin: "allow", policy: "allow", permission: "ask" });
  assert.equal(p.stage, "permission");
  assert.equal(p.askUser, true);
  assert.equal(p.execute, false);
  assert.equal(p.errorCode, undefined);
});
