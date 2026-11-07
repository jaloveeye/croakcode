import test from "node:test";
import assert from "node:assert/strict";
import { recoverOnResume, canAutoReexecute } from "@croakcode/control";

// §4.5: 재시작 시 "running" 상태로 남은 실행은 결과를 모르므로 unknown으로 해석한다.
test("lingering running resolves to unknown (spec §4.5)", () => {
  assert.equal(recoverOnResume("running"), "unknown");
  assert.equal(recoverOnResume("succeeded"), "succeeded");
  assert.equal(recoverOnResume("failed"), "failed");
});

// unknown 상태에서는 부작용이 있는 도구를 절대 자동 재실행하지 않는다.
test("unknown never auto-reexecutes side-effect tools", () => {
  assert.equal(canAutoReexecute("unknown", { hasSideEffects: true, reexecutionSafe: true }), false);
  assert.equal(canAutoReexecute("unknown", { hasSideEffects: true, reexecutionSafe: false }), false);
});

// 부작용 없고 재실행 안전한 도구만 unknown에서 자동 재실행할 수 있다.
test("unknown auto-reexecutes only side-effect-free + reexecution-safe tools", () => {
  assert.equal(canAutoReexecute("unknown", { hasSideEffects: false, reexecutionSafe: true }), true);
  assert.equal(canAutoReexecute("unknown", { hasSideEffects: false, reexecutionSafe: false }), false);
});
