import test from "node:test";
import assert from "node:assert/strict";
import { buildRecord, createMeter } from "../upstream/.croakcode/plugins/usage-meter.js";

const tokens = { input: 2000, output: 300, reasoning: 100, cache: { read: 50000, write: 0 } };

test("buildRecord computes prefill and decode speed", () => {
  const r = buildRecord({ requestAt: 1000, firstAt: 2000, finishAt: 12000, tokens, sessionID: "s", messageID: "m" });
  assert.equal(r.ttftMs, 1000);
  assert.equal(r.decodeMs, 10000);
  assert.equal(r.prefillTps, 2000);
  assert.equal(r.decodeTps, 40);
  assert.deepEqual(r.tokens, { input: 2000, output: 300, reasoning: 100, cacheRead: 50000, cacheWrite: 0 });
});

test("buildRecord leaves speeds empty without timing or on tiny intervals", () => {
  const r = buildRecord({ finishAt: 5000, tokens, sessionID: "s", messageID: "m" });
  assert.equal(r.ttftMs, null);
  assert.equal(r.prefillTps, null);
  assert.equal(r.decodeTps, null);
  const tiny = buildRecord({ requestAt: 1000, firstAt: 1010, finishAt: 1020, tokens, sessionID: "s", messageID: "m" });
  assert.equal(tiny.prefillTps, null);
  assert.equal(tiny.decodeTps, null);
  const short = buildRecord({ requestAt: 0, firstAt: 1000, finishAt: 2000, tokens: { ...tokens, output: 2, reasoning: 0 } });
  assert.equal(short.decodeTps, null);
});

test("meter ties request, first chunk and finish of each step", async () => {
  let clock = 0;
  const out = [];
  const meter = createMeter({ now: () => clock, write: async (r) => void out.push(r) });
  const part = (type, extra = {}) => ({
    type: "message.part.updated",
    properties: { part: { type, sessionID: "s1", messageID: "m1", ...extra } },
  });

  await meter.onEvent({
    type: "message.updated",
    properties: { info: { id: "m1", role: "assistant", agent: "dev-main", providerID: "litellm-head", modelID: "default", time: {} } },
  });

  // Step 1: tool call.
  clock = 100;
  meter.onRequest({ sessionID: "s1", agent: "dev-main", model: { providerID: "litellm-head", id: "default" } });
  clock = 600;
  await meter.onEvent(part("step-start"));
  clock = 1600;
  await meter.onEvent(part("step-finish", { reason: "tool-calls", tokens }));

  // Step 2 in the same message after the tool ran.
  clock = 5000;
  meter.onRequest({ sessionID: "s1", agent: "dev-main", model: { providerID: "litellm-head", id: "default" } });
  clock = 5250;
  await meter.onEvent(part("step-start"));
  clock = 7250;
  await meter.onEvent(part("step-finish", { reason: "stop", tokens: { ...tokens, input: 500 } }));

  assert.equal(out.length, 2);
  assert.equal(out[0].ttftMs, 500);
  assert.equal(out[0].prefillTps, 4000);
  assert.equal(out[0].decodeTps, 400);
  assert.equal(out[0].agent, "dev-main");
  assert.equal(out[0].modelID, "default");
  assert.equal(out[1].ttftMs, 250);
  assert.equal(out[1].prefillTps, 2000);
  assert.equal(out[1].decodeTps, 200);
  assert.equal(out[1].finish, "stop");
});

test("a finish without a recorded request still logs tokens", async () => {
  const out = [];
  const meter = createMeter({ now: () => 1000, write: async (r) => void out.push(r) });
  await meter.onEvent({
    type: "message.part.updated",
    properties: { part: { type: "step-finish", sessionID: "s", messageID: "m", reason: "stop", tokens } },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].ttftMs, null);
  assert.equal(out[0].tokens.output, 300);
});
