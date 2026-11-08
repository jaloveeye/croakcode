/**
 * TODO 표시 ↔ 실제 작업 동기화 계약. Spec §4.8.
 * upstream 은 TodoTable(session.sql.ts) + todo.updated 로 이미 영속한다.
 * 이 계약은 부족한 부분(evidence 정책, linkedToolCalls, 정합성 경고)을 정의한다.
 */
export const TODO_STATUSES = Object.freeze(["pending", "in_progress", "completed", "cancelled"]);

export const TODO_EVIDENCE = Object.freeze(["tool", "none"]);

/** upstream BusEvent 규칙(prefix 없음)과 일치. Spec §4.8 이벤트 명명(정본). */
export const TODO_EVENTS = Object.freeze({
  updated: "todo.updated",
  inconsistent: "todo.inconsistent",
});

export const TODO_WARNINGS = Object.freeze([
  "completed_without_evidence",
  "in_progress_without_evidence",
  "invalid_todo",
  "invalid_status",
]);

/**
 * 턴 종료 정합성 판정. evidence:"none" 은 도구 증거를 요구하지 않는다(오탐 방지).
 * in_progress 는 턴 단위 판정 금지 — 진입 턴에만 확인한다.
 */
export function checkTodoConsistency(todo, turnCalls, entryTurnCalls) {
  if (!todo || typeof todo !== "object") return ["invalid_todo"];
  const warnings = [];
  if (!TODO_STATUSES.includes(todo.status)) warnings.push("invalid_status");
  const evidence = todo.evidence ?? "tool";
  const linked = Array.isArray(todo.linkedToolCalls) ? todo.linkedToolCalls : [];
  if (evidence === "tool" && todo.status === "completed" && linked.length === 0) {
    warnings.push("completed_without_evidence");
  }
  if (evidence === "tool" && todo.status === "in_progress") {
    const entry = Array.isArray(entryTurnCalls) ? entryTurnCalls : [];
    const calledInEntryTurn = entry.some((id) => linked.includes(id));
    if (entry.length > 0 && !calledInEntryTurn && linked.length === 0) {
      warnings.push("in_progress_without_evidence");
    }
  }
  return warnings;
}
