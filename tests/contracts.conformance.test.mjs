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
