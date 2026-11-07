/**
 * @typedef {"allow"|"deny"|"ask"} Decision
 * @typedef {Object} ExecutionInput
 * @property {string} tool
 * @property {string} sessionID
 * @property {unknown} args
 * @property {Decision} plugin
 * @property {Decision} policy
 * @property {Decision} permission
 * @typedef {Object} ExecutionPlan
 * @property {"plugin"|"policy"|"permission"|"execute"} stage
 * @property {boolean} execute
 * @property {boolean} askUser
 * @property {string} [denyReason]
 */

export function resolveExecutionPlan(input) {
  // Order (spec §3.4): validate -> plugin -> policy -> permission -> execute.
  // deny-first: ANY deny stops immediately.
  if (input.plugin === "deny") {
    return { stage: "plugin", execute: false, askUser: false, denyReason: "plugin policy deny" };
  }
  if (input.policy === "deny") {
    return { stage: "policy", execute: false, askUser: false, denyReason: "gate policy deny" };
  }
  if (input.permission === "deny") {
    return { stage: "permission", execute: false, askUser: false, denyReason: "permission deny" };
  }
  // Only after ALL deny checks pass do we consider "ask".
  if (input.permission === "ask" || input.plugin === "ask") {
    return { stage: "permission", execute: false, askUser: true };
  }
  return { stage: "execute", execute: true, askUser: false };
}
