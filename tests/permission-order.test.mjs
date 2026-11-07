import test from "node:test";
import assert from "node:assert/strict";
import { resolveExecutionPlan } from "@croakcode/control";

const base = { tool: "bash", sessionID: "s1", args: {} };

test("plugin deny short-circuits before policy/permission", () => {
  const p = resolveExecutionPlan({ ...base, plugin: "deny", policy: "allow", permission: "allow" });
  assert.equal(p.stage, "plugin");
  assert.equal(p.execute, false);
  assert.equal(p.askUser, false);
});

test("policy deny beats permission allow", () => {
  const p = resolveExecutionPlan({ ...base, plugin: "allow", policy: "deny", permission: "allow" });
  assert.equal(p.stage, "policy");
  assert.equal(p.execute, false);
});

test("plugin ask + policy deny => deny wins, never asks", () => {
  const p = resolveExecutionPlan({ ...base, plugin: "ask", policy: "deny", permission: "allow" });
  assert.equal(p.stage, "policy");
  assert.equal(p.execute, false);
  assert.equal(p.askUser, false);
});

test("policy checked before permission ask", () => {
  const p = resolveExecutionPlan({ ...base, plugin: "allow", policy: "allow", permission: "ask" });
  assert.equal(p.stage, "permission");
  assert.equal(p.askUser, true);
  assert.equal(p.execute, false);
});

test("plugin ask with all denies cleared surfaces at permission stage for approval", () => {
  const p = resolveExecutionPlan({ ...base, plugin: "ask", policy: "allow", permission: "allow" });
  assert.equal(p.stage, "permission");
  assert.equal(p.askUser, true);
  assert.equal(p.execute, false);
});

test("all allow executes", () => {
  const p = resolveExecutionPlan({ ...base, plugin: "allow", policy: "allow", permission: "allow" });
  assert.equal(p.stage, "execute");
  assert.equal(p.execute, true);
});
