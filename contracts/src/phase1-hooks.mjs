/**
 * Phase 1 hook stubs — interface only, no-op. Spec §8.2.
 * Upstream already provides the plugin hook machinery; croakcode wires real
 * adapters in Phase 2. This descriptor documents the no-op contract.
 */
export const PHASE1_HOOK_STUBS = Object.freeze({
  phase: 1,
  implemented: false,
  noop: true,
  hooks: Object.freeze([
    "chat.headers",
    "chat.params",
    "tool.execute.before",
    "command.execute.before",
    "event",
  ]),
});
