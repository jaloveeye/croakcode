import test from "node:test";
import assert from "node:assert/strict";
import { resolveConnectionMode, isGateOnlyPart, filterMessagesForMode, filterMessagesForModeParts } from "../upstream/.croakcode/plugins/lib/connection.js";

// --- Spec §5.3 precedence: agent.force > session override > global ---

test("mode precedence: agentForce > session > global > default gate", () => {
  assert.equal(resolveConnectionMode({ agentForce: "gate", session: "direct", global: "direct" }), "gate");
  assert.equal(resolveConnectionMode({ session: "direct", global: "gate" }), "direct");
  assert.equal(resolveConnectionMode({ global: "direct" }), "direct");
  assert.equal(resolveConnectionMode({}), "gate"); // fail-safe default
  assert.equal(resolveConnectionMode({ agentForce: "direct" }), "direct");
});

test("invalid/unknown mode values fall back to gate (fail-closed)", () => {
  assert.equal(resolveConnectionMode({ session: "bogus" }), "gate");
  assert.equal(resolveConnectionMode({ global: "GATE" }), "gate");
  assert.equal(resolveConnectionMode({ agentForce: null, session: undefined, global: "direct" }), "direct");
});

// --- gate-only part detection uses metadata.origin, never string guessing ---

test("gate-only part detection uses metadata.origin, not string guessing", () => {
  assert.equal(isGateOnlyPart({ type: "text", metadata: { origin: "gate" } }), true);
  assert.equal(isGateOnlyPart({ type: "tool", metadata: { origin: "gate", sensitivity: "secret" } }), true);
  assert.equal(isGateOnlyPart({ type: "text", metadata: {} }), false);
  assert.equal(isGateOnlyPart({ type: "text" }), false);
  assert.equal(isGateOnlyPart(null), false);
  assert.equal(isGateOnlyPart({ type: "text", metadata: { origin: "gate-ish" } }), false);
});

// --- direct mode drops gate-origin / unlabeled assistant parts; gate keeps all ---

test("direct mode drops gate-origin and unstamped parts (fail-closed); gate keeps all", () => {
  const msgs = [
    { role: "user", parts: [{ type: "text", text: "hi", metadata: {} }] },
    { role: "assistant", parts: [{ type: "text", text: "secret", metadata: { origin: "gate" } }] },
    // No origin stamp: cannot be proven safe to replay to a direct provider.
    { role: "assistant", parts: [{ type: "text", text: "unlabeled" }] },
    // Explicitly user-trusted assistant text is safe.
    { role: "assistant", parts: [{ type: "text", text: "trusted", metadata: { origin: "user" } }] },
  ];
  const direct = filterMessagesForMode(msgs, "direct");
  assert.deepEqual(direct.map((m) => m.role), ["user", "assistant"]);
  assert.equal(direct[0].parts[0].text, "hi");
  assert.equal(direct[1].parts[0].text, "trusted");
  const gate = filterMessagesForMode(msgs, "gate");
  assert.equal(gate.length, 4);
  assert.equal(gate, msgs, "gate mode must return the same array (no copy)");
});

test("genuine user message that mentions secrets is kept in direct mode", () => {
  const msgs = [{ role: "user", parts: [{ type: "text", text: "C:\\secret.txt", metadata: { origin: "user" } }] }];
  assert.equal(filterMessagesForMode(msgs, "direct").length, 1);
});

test("synthetic user turn injecting gate-stamped sub-agent output is withheld in direct mode", () => {
  const msgs = [{ role: "user", parts: [{ type: "text", text: "subagent secret", metadata: { origin: "gate" } }] }];
  assert.equal(filterMessagesForMode(msgs, "direct").length, 0);
});

// --- part-level variant used by the real runtime (MessageV2 messages) ---

test("filterMessagesForModeParts drops gate-origin and unstamped assistant messages (fail-closed)", () => {
  const msgs = [
    { info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "hi", metadata: {} }] },
    { info: { role: "assistant", id: "a1" }, parts: [{ type: "text", text: "secret", metadata: { origin: "gate" } }] },
    // a2 has no origin stamp → fail-closed drop in direct mode.
    { info: { role: "assistant", id: "a2" }, parts: [{ type: "text", text: "unlabeled" }] },
    { info: { role: "assistant", id: "a3" }, parts: [{ type: "text", text: "ok", metadata: { origin: "user" } }] },
    { info: { role: "assistant", id: "a4" }, parts: [{ type: "reasoning", text: "r", metadata: { origin: "user" } }] },
  ];
  const direct = filterMessagesForModeParts(msgs, "direct");
  assert.deepEqual(
    direct.map((m) => m.info.id),
    ["u1", "a3", "a4"],
  );
  const gate = filterMessagesForModeParts(msgs, "gate");
  assert.equal(gate.length, 5);
  assert.equal(gate, msgs, "gate mode must return the same array (no copy)");
});

test("unlabeled non-text assistant part (tool/reasoning) is dropped in direct mode", () => {
  const msgs = [{ info: { role: "assistant", id: "a1" }, parts: [{ type: "tool", tool: "bash", state: {} }] }];
  assert.equal(filterMessagesForModeParts(msgs, "direct").length, 0);
  assert.equal(filterMessagesForMode(msgs, "direct").length, 0);
});

test("filterMessagesForModeParts treats a message with zero parts as safe", () => {
  const msgs = [{ info: { role: "assistant", id: "a1" }, parts: [] }];
  assert.equal(filterMessagesForModeParts(msgs, "direct").length, 1);
});
