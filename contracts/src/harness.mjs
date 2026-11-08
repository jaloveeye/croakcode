/**
 * 권한 기반 동적 하네스/스킬 할당 계약. Spec §4.7.
 * Phase 2: 포트 계약만. 실제 재산정은 upstream tool registry / skill discovery 에 연결.
 */
export const HARNESS_DECISIONS = Object.freeze(["allow", "ask", "deny", "not_applicable"]);

export const HARNESS_REFRESH_TRIGGERS = Object.freeze([
  "session_start",
  "turn_start",
  "permission_reply",
  "connection_mode_switch",
  "subagent_spawn",
  "permission_profile_change",
]);

/**
 * 권한 판정 → 하네스 포함 여부.
 * fail-closed: 알 수 없는 decision 은 deny 로 취급한다.
 */
export function resolveHarnessInclusion(decision) {
  if (decision === "allow") return "include";
  if (decision === "ask") return "include_requires_approval";
  return "exclude"; // deny / not_applicable / undefined / unknown
}

/**
 * 도구 목록 노출 판정 — fail-closed. allow/ask 만 노출, 그 외 전부 제외.
 * 런타임의 Permission.evaluate 는 항상 유효한 action 을 반환하지만,
 * 방어적으로 알 수 없는 값도 제외한다.
 */
export function shouldExposeTool(decision) {
  return decision === "allow" || decision === "ask";
}

export const HARNESS_EVENT = Object.freeze({
  name: "harness.updated",
  direction: "core→client",
  snapshot: true,
});
