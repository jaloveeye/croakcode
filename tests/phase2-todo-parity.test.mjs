import test from "node:test";
import assert from "node:assert/strict";
import { checkTodoConsistency, TODO_STATUSES, TODO_EVIDENCE, TODO_EVENTS } from "@croakcode/contracts";

// Contract-side truth table. The upstream `consistencyWarnings` is asserted
// against the same cases in test/session/todo-consistency.test.ts, so both
// sides agree on warning labels and evidence semantics (no logic copy here).
const CASES = [
  { name: "completed/tool/no-linked", todo: { status: "completed", evidence: "tool", linkedToolCalls: [] }, turnCalls: [], entryTurnCalls: [], expected: ["completed_without_evidence"] },
  { name: "completed/none/no-linked", todo: { status: "completed", evidence: "none", linkedToolCalls: [] }, turnCalls: [], entryTurnCalls: [], expected: [] },
  { name: "completed/tool/linked", todo: { status: "completed", evidence: "tool", linkedToolCalls: ["c1"] }, turnCalls: ["c1"], entryTurnCalls: [], expected: [] },
  { name: "completed/default-evidence/no-linked", todo: { status: "completed", linkedToolCalls: [] }, turnCalls: [], entryTurnCalls: [], expected: ["completed_without_evidence"] },
  { name: "in_progress/spanning-turns", todo: { status: "in_progress", linkedToolCalls: ["c1"] }, turnCalls: ["c1"], entryTurnCalls: ["c1"], expected: [] },
  { name: "in_progress/no-entry-calls", todo: { status: "in_progress", linkedToolCalls: [] }, turnCalls: [], entryTurnCalls: ["cx"], expected: ["in_progress_without_evidence"] },
  { name: "invalid-status", todo: { status: "done" }, turnCalls: [], entryTurnCalls: [], expected: ["invalid_status"] },
  { name: "malformed", todo: null, turnCalls: [], entryTurnCalls: [], expected: ["invalid_todo"] },
];

test("contract consistency truth table is stable", () => {
  for (const c of CASES) {
    assert.deepEqual(checkTodoConsistency(c.todo, c.turnCalls, c.entryTurnCalls), c.expected, c.name);
  }
});

test("contract labels align with upstream status/evidence/event vocabulary", () => {
  assert.deepEqual(TODO_STATUSES, ["pending", "in_progress", "completed", "cancelled"]);
  assert.deepEqual(TODO_EVIDENCE, ["tool", "none"]);
  assert.equal(TODO_EVENTS.updated, "todo.updated");
  assert.equal(TODO_EVENTS.inconsistent, "todo.inconsistent");
});
