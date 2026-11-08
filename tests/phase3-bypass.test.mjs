import test from "node:test";
import assert from "node:assert/strict";
import { resolveExecutionPlan, resolveEffectiveMode } from "@croakcode/control";
import { resolveConnectionMode } from "../upstream/.croakcode/plugins/lib/connection.js";

const base = { tool: "bash", sessionID: "s1", args: {} };

// §5.4-1: agent.force gate + direct 요청 => 거부(force 우선), 경고 기록
test("1. force gate beats session direct switch", () => {
  const r = resolveEffectiveMode({ agentForce: "gate", sessionOverride: "direct", requiresAuth: true });
  assert.equal(r.mode, "gate");
  assert.equal(r.ok, true);
  assert.match(r.warning ?? "", /overrides direct/);

  // The runtime helper must reach the same conclusion.
  assert.equal(resolveConnectionMode({ agentForce: "gate", session: "direct" }), "gate");
});

// §5.4-2: direct + requiresAuth => 실행 전 오류(자동 upgrade 없음)
test("2. requiresAuth on direct fails closed", () => {
  const r = resolveEffectiveMode({ sessionOverride: "direct", global: "direct", requiresAuth: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /requires gate/);

  // And a plan built from an unresolvable mode never executes.
  const plan = resolveExecutionPlan({ ...base, mode: "direct-with-auth", plugin: "allow", policy: "allow", permission: "allow" });
  assert.equal(plan.execute, false);
  assert.equal(plan.stage, "validate");
  assert.equal(plan.errorCode, "INVALID_INPUT");
});

// §5.4-3: 로컬 설정으로 서버 deny 완화 시도 => 무시 (policy가 permission보다 우선)
test("3. local config cannot relax server gate deny", () => {
  const p = resolveExecutionPlan({ ...base, mode: "gate", plugin: "allow", policy: "deny", permission: "allow" });
  assert.equal(p.stage, "policy");
  assert.equal(p.execute, false);
  assert.equal(p.errorCode, "POLICY_DENIED");
});

test("3b. gate policy unavailable is fail-closed", () => {
  const p = resolveExecutionPlan({ ...base, mode: "gate", plugin: "allow", policy: "not_applicable", permission: "allow" });
  assert.equal(p.stage, "policy");
  assert.equal(p.execute, false);
  assert.equal(p.errorCode, "POLICY_UNAVAILABLE");
});

test("3c. plugin deny stops before policy (order §3.4)", () => {
  const p = resolveExecutionPlan({ ...base, mode: "gate", plugin: "deny", policy: "allow", permission: "allow" });
  assert.equal(p.stage, "plugin");
  assert.equal(p.execute, false);
  assert.equal(p.errorCode, "PLUGIN_DENIED");
});

// §5.4-4a: 모드 판정 절반 — gate-only 도구는 direct로 바꿔도 정책상 차단 경로 유지
test("4a. gate-only tool stays gate-gated during auth failure", () => {
  const mode = resolveConnectionMode({ agentForce: "gate", session: "direct" });
  assert.equal(mode, "gate");
  const p = resolveExecutionPlan({ ...base, mode, plugin: "allow", policy: "allow", permission: "allow" });
  assert.equal(p.execute, true);

  const direct = resolveConnectionMode({ session: "direct", global: "direct" });
  assert.equal(direct, "direct");
  // direct에서도 policy deny는 유지된다(로컬 완화 불가).
  const denied = resolveExecutionPlan({ ...base, mode: direct, plugin: "allow", policy: "deny", permission: "allow" });
  assert.equal(denied.execute, false);
  assert.equal(denied.errorCode, "POLICY_DENIED");
});

// Unresolvable mode signal: fail-closed to gate, never silently direct.
test("4a'. missing/unknown mode resolves to gate", () => {
  assert.equal(resolveConnectionMode({}), "gate");
  assert.equal(resolveConnectionMode({ session: "DIRECT" }), "gate");
});
