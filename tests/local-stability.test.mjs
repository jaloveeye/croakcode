import test from "node:test";
import assert from "node:assert/strict";
const plugin = (await import("../upstream/.croakcode/plugins/local-stability.js")).default;

test("exports id and all expected hooks", async () => {
  assert.equal(plugin.id, "croak-local-stability");
  const hooks = await plugin.server({ client: { tui: { showToast: async () => {} }, session: { abort: async () => {} } } });
  for (const h of ["tool.execute.before", "event", "experimental.session.compacting", "experimental.compaction.autocontinue"])
    assert.equal(typeof hooks[h], "function", h);
  // Sampling belongs to the gate's model registry, not to a model id here.
  assert.equal(hooks["chat.params"], undefined);
});

test("identical read 4th time throws", async () => {
  const hooks = await plugin.server({ client: { tui: { showToast: async () => {} }, session: { abort: async () => {} } } });
  const input = { tool: "read", sessionID: "s1" }, output = { args: { filePath: "a.ts" } };
  for (let i = 0; i < 3; i++) await hooks["tool.execute.before"](input, output);
  await assert.rejects(() => hooks["tool.execute.before"](input, output), /Repeated non-progress/);
});

test("the output-limit warning shows for any model behind the gate", async () => {
  const toasts = [];
  const hooks = await plugin.server({ client: { tui: { showToast: async (t) => toasts.push(t) }, session: { abort: async () => {} } } });
  const event = (info) => ({ event: { type: "message.updated", properties: { info } } });
  await hooks.event(event({ id: "m1", role: "assistant", providerID: "litellm-head", modelID: "croak", finish: "length", sessionID: "s1" }));
  await hooks.event(event({ id: "m2", role: "assistant", providerID: "other", modelID: "x", finish: "length", sessionID: "s1" }));
  assert.equal(toasts.length, 1);
});

test("compaction prompt does not disable built-in idle guard", async () => {
  const hooks = await plugin.server({ client: {} });
  const out = {};
  await hooks["experimental.session.compacting"]({}, out);
  assert.match(out.prompt, /continuation checkpoint/i);
  const ac = {};
  await hooks["experimental.compaction.autocontinue"]({}, ac);
  assert.equal(ac.enabled, true);
});
