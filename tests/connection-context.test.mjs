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

test("direct mode drops gate-origin parts and unknown-origin parts; gate mode keeps all", () => {
  const msgs = [
    { role: "user", parts: [{ type: "text", text: "hi", metadata: {} }] },
    { role: "assistant", parts: [{ type: "text", text: "secret", metadata: { origin: "gate" } }] },
    { role: "assistant", parts: [{ type: "text", text: "unlabeled" }] }, // unknown origin
  ];
  const direct = filterMessagesForMode(msgs, "direct");
  // gate-origin 제거 (fail-closed). 메타데이터가 아예 없는 assistant *text* part는
  // 평범한 모델 출력이므로 남긴다 — 제외 조건은 gate-origin 또는 비-text 무metadata다.
  assert.deepEqual(direct.map((m) => m.role), ["user", "assistant"]);
  assert.equal(direct[0].parts[0].text, "hi");
  assert.equal(direct[1].parts[0].text, "unlabeled");
  const gate = filterMessagesForMode(msgs, "gate");
  assert.equal(gate.length, 3);
  assert.equal(gate, msgs, "gate mode must return the same array (no copy)");
});

test("user message that mentions secrets is kept in direct mode", () => {
  const msgs = [{ role: "user", parts: [{ type: "text", text: "C:\\secret.txt", metadata: { origin: "gate" } }] }];
  assert.equal(filterMessagesForMode(msgs, "direct").length, 1);
});

// --- part-level variant used by the real runtime (MessageV2 messages) ---

test("filterMessagesForModeParts drops gate-origin and unlabeled assistant messages", () => {
  const msgs = [
    { info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "hi", metadata: {} }] },
    { info: { role: "assistant", id: "a1" }, parts: [{ type: "text", text: "secret", metadata: { origin: "gate" } }] },
    { info: { role: "assistant", id: "a2" }, parts: [{ type: "text", text: "unlabeled" }] },
    { info: { role: "assistant", id: "a3" }, parts: [{ type: "text", text: "ok", metadata: { origin: "user" } }] },
    { info: { role: "assistant", id: "a4" }, parts: [{ type: "reasoning", text: "r", metadata: { origin: "user" } }] },
  ];
  const direct = filterMessagesForModeParts(msgs, "direct");
  // a2 (metadata 없는 assistant *text*) 는 모델 출력이므로 남는다.
  assert.deepEqual(
    direct.map((m) => m.info.id),
    ["u1", "a2", "a3", "a4"],
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
