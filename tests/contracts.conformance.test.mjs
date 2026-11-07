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
