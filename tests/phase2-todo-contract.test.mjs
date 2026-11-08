import test from "node:test";
import assert from "node:assert/strict";
import { checkTodoConsistency, TODO_STATUSES, TODO_EVIDENCE, TODO_EVENTS } from "@croakcode/contracts";

test("evidence:tool completed without linked calls warns", () => {
  assert.deepEqual(checkTodoConsistency({ status: "completed", evidence: "tool", linkedToolCalls: [] }, [], []), [
    "completed_without_evidence",
  ]);
});

test("evidence:none completed without linked calls does NOT warn", () => {
  assert.deepEqual(checkTodoConsistency({ status: "completed", evidence: "none", linkedToolCalls: [] }, [], []), []);
});

test("completed with linked call is consistent", () => {
  assert.deepEqual(
    checkTodoConsistency({ status: "completed", evidence: "tool", linkedToolCalls: ["call_1"] }, ["call_1"], []),
    [],
  );
});

test("missing evidence defaults to tool", () => {
  assert.deepEqual(checkTodoConsistency({ status: "completed", linkedToolCalls: [] }, [], []), [
    "completed_without_evidence",
  ]);
});

test("in_progress spanning turns is not a false positive", () => {
  // 진입 턴에 호출이 있었으면 이후 턴에 호출이 없어도 경고 없음
  assert.deepEqual(
    checkTodoConsistency({ status: "in_progress", linkedToolCalls: ["call_1"] }, ["call_1"], ["call_1"]),
    [],
  );
});

test("in_progress entered with no tool calls warns", () => {
  assert.deepEqual(checkTodoConsistency({ status: "in_progress", linkedToolCalls: [] }, [], ["call_x"]), [
    "in_progress_without_evidence",
  ]);
});

test("invalid status and malformed input fail detectably", () => {
  assert.deepEqual(checkTodoConsistency({ status: "done" }, [], []), ["invalid_status"]);
  assert.deepEqual(checkTodoConsistency(null, [], []), ["invalid_todo"]);
});

test("todo contract declares statuses, evidence, and upstream event names", () => {
  assert.deepEqual(TODO_STATUSES, ["pending", "in_progress", "completed", "cancelled"]);
  assert.deepEqual(TODO_EVIDENCE, ["tool", "none"]);
  assert.equal(TODO_EVENTS.updated, "todo.updated");
  assert.equal(TODO_EVENTS.inconsistent, "todo.inconsistent");
});
