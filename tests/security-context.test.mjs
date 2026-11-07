import test from "node:test";
import assert from "node:assert/strict";
import { resolveEffectiveMode } from "@croakcode/control";

// --- Spec §5.3 precedence: agent.force > session override > global ---

test("agent.force gate beats session direct (with warning)", () => {
  const r = resolveEffectiveMode({
    agentForce: "gate",
    sessionOverride: "direct",
    global: "direct",
    requiresAuth: false,
  });
  assert.equal(r.mode, "gate");
  assert.equal(r.ok, true);
  assert.ok(r.warning);
  assert.equal(r.error, undefined);
});

test("session direct overrides global gate", () => {
  const r = resolveEffectiveMode({
    agentForce: undefined,
    sessionOverride: "direct",
    global: "gate",
  });
  assert.equal(r.mode, "direct");
  assert.equal(r.ok, true);
});

test("requiresAuth + direct (global) => error", () => {
  const r = resolveEffectiveMode({
    agentForce: undefined,
    sessionOverride: undefined,
    global: "direct",
    requiresAuth: true,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /gate/);
});

test("requiresAuth + session direct + global gate => error", () => {
  const r = resolveEffectiveMode({
    agentForce: undefined,
    sessionOverride: "direct",
    global: "gate",
    requiresAuth: true,
  });
  assert.equal(r.mode, "direct");
  assert.equal(r.ok, false);
  assert.match(r.error, /gate/);
});

test("requiresAuth + global gate => ok", () => {
  const r = resolveEffectiveMode({
    agentForce: undefined,
    sessionOverride: undefined,
    global: "gate",
    requiresAuth: true,
  });
  assert.equal(r.mode, "gate");
  assert.equal(r.ok, true);
});

// --- Edge cases ---

test("agent.force gate alone (no overrides, not auth) => gate ok, no warning", () => {
  const r = resolveEffectiveMode({
    agentForce: "gate",
    sessionOverride: undefined,
    global: undefined,
    requiresAuth: false,
  });
  assert.equal(r.mode, "gate");
  assert.equal(r.ok, true);
  assert.equal(r.warning, undefined);
});

test("requiresAuth + forced gate over session direct => ok (forced gate satisfies auth)", () => {
  const r = resolveEffectiveMode({
    agentForce: "gate",
    sessionOverride: "direct",
    global: "direct",
    requiresAuth: true,
  });
  assert.equal(r.mode, "gate");
  assert.equal(r.ok, true);
});

test("no mode resolvable (all absent) => fail-closed, mode undefined", () => {
  const r = resolveEffectiveMode({
    agentForce: undefined,
    sessionOverride: undefined,
    global: undefined,
    requiresAuth: false,
  });
  assert.equal(r.mode, undefined);
  assert.equal(r.ok, false);
  assert.match(r.error, /mode/);
});
