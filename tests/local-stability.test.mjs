import test from "node:test";
import assert from "node:assert/strict";
const plugin = (await import("../upstream/.croakcode/plugins/local-stability.js")).default;

test("exports id and all expected hooks", async () => {
  assert.equal(plugin.id, "croak-local-stability");
  const hooks = await plugin.server({ client: { tui: { showToast: async () => {} }, session: { abort: async () => {} } } });
  for (const h of ["tool.execute.before", "event", "chat.params", "experimental.session.compacting", "experimental.compaction.autocontinue"])
    assert.equal(typeof hooks[h], "function", h);
});

test("identical read 4th time throws", async () => {
  const hooks = await plugin.server({ client: { tui: { showToast: async () => {} }, session: { abort: async () => {} } } });
  const input = { tool: "read", sessionID: "s1" }, output = { args: { filePath: "a.ts" } };
  for (let i = 0; i < 3; i++) await hooks["tool.execute.before"](input, output);
  await assert.rejects(() => hooks["tool.execute.before"](input, output), /Repeated non-progress/);
});

test("qwen params adjusted for litellm-head", async () => {
  const hooks = await plugin.server({ client: {} });
  const out = {};
  await hooks["chat.params"]({ model: { providerID: "litellm-head", id: "qwen3.8-27b-nvfp4" } }, out);
  assert.equal(out.temperature, 1.0);
  assert.equal(out.topP, 0.95);
  const out2 = { options: { chat_template_kwargs: { enable_thinking: false } } };
  await hooks["chat.params"]({ model: { providerID: "litellm-head", id: "qwen3.8-27b-nvfp4" } }, out2);
  assert.equal(out2.temperature, 0.7);
  assert.equal(out2.topP, 0.8);
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
