import test from "node:test";
import assert from "node:assert/strict";
import * as contracts from "@croakcode/contracts";

test("contracts exports hooks descriptor", () => {
  assert.ok(contracts.HOOK_NAMES, "HOOK_NAMES export missing");
  assert.deepEqual(contracts.HOOK_NAMES, [
    "chat.headers", "chat.params",
    "tool.execute.before", "tool.execute.after",
    "command.execute.before", "event",
  ]);
});

test("Delta kinds separate tool_call phases", () => {
  assert.deepEqual(contracts.DELTA_KINDS, ["text","tool_call.start","tool_call.delta","tool_call.completed","usage","reasoning","stop","error"]);
});
test("ToolSpec requires side-effect and reexecution flags", () => {
  assert.deepEqual(contracts.TOOL_SPEC_REQUIRED, ["name", "hasSideEffects", "reexecutionSafe"]);
});

test("server auth describes the Phase 4 execution permit contract", () => {
  assert.equal(typeof contracts.SERVER_AUTH_DESCRIPTOR, "object");
  assert.equal(contracts.SERVER_AUTH_DESCRIPTOR.phase, 4);
  // Client-side verification is implemented; server reconciliation is croak-gate's.
  assert.equal(contracts.SERVER_AUTH_DESCRIPTOR.implemented, "client-verification");
  assert.equal(contracts.SERVER_AUTH_DESCRIPTOR.signature, "ed25519");
  assert.equal(contracts.SERVER_AUTH_DESCRIPTOR.endpoint, "/v1/execution-permits");
  assert.equal(contracts.SERVER_AUTH_DESCRIPTOR.maxTtlMs, 60_000);
  assert.equal(contracts.SERVER_AUTH_DESCRIPTOR.serverReconciliation, "croak-gate");
});

test("TUI surface contract promotes patch 0006/0007", () => {
  assert.ok(contracts.TUI_HOST_SLOTS.includes("session_message_footer"));
  assert.deepEqual(contracts.SESSION_MESSAGE_FOOTER_PROPS, ["session_id", "message_id"]);
  assert.deepEqual(contracts.TUI_PERMISSION_MODES, ["ask", "auto"]);
  assert.equal(contracts.TUI_PERMISSION_API.readOnly, true);
});

test("phase 1 hook stubs are declared no-op", () => {
  assert.equal(contracts.PHASE1_HOOK_STUBS.phase, 1);
  assert.equal(contracts.PHASE1_HOOK_STUBS.implemented, false);
  assert.equal(contracts.PHASE1_HOOK_STUBS.noop, true);
  assert.ok(contracts.PHASE1_HOOK_STUBS.hooks.includes("tool.execute.before"));
});
