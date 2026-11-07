/**
 * @typedef {"allow"|"deny"|"ask"} Decision
 * @typedef {"gate"|"direct"} Mode
 * @typedef {"allow"|"deny"|"ask"|"not_applicable"} PolicyDecision
 * @typedef {Object} ExecutionInput
 * @property {string} tool
 * @property {string} sessionID
 * @property {unknown} args
 * @property {Mode} mode
 * @property {Decision} plugin
 * @property {PolicyDecision} policy
 * @property {Decision} permission
 * @typedef {Object} ExecutionPlan
 * @property {"validate"|"plugin"|"policy"|"permission"|"execute"} stage
 * @property {boolean} execute
 * @property {boolean} askUser
 * @property {("INVALID_INPUT"|"INVALID_DECISION"|"PLUGIN_DENIED"|"POLICY_DENIED"|"POLICY_UNAVAILABLE"|"PERMISSION_DENIED")} [errorCode]
 * @property {string} [denyReason]
 */

const DECISIONS = ["allow", "deny", "ask"];
const POLICY_DECISIONS = ["allow", "deny", "not_applicable"];

/**
 * @param {ExecutionInput} input
 * @returns {ExecutionPlan}
 */
export function resolveExecutionPlan(input) {
  // Order (spec §3.4): validate -> plugin -> policy -> permission -> execute.
  // Fail-closed: the first invalid or denying signal stops immediately.

  // 1. Validate (fail-closed first).
  const { mode, plugin, policy, permission } = input;

  if (mode !== "gate" && mode !== "direct") {
    return {
      stage: "validate",
      execute: false,
      askUser: false,
      errorCode: "INVALID_INPUT",
      denyReason: "invalid or missing mode",
    };
  }

  if (!DECISIONS.includes(plugin)) {
    return {
      stage: "validate",
      execute: false,
      askUser: false,
      errorCode: "INVALID_DECISION",
      denyReason: "invalid or missing decision: plugin",
    };
  }

  if (!DECISIONS.includes(permission)) {
    return {
      stage: "validate",
      execute: false,
      askUser: false,
      errorCode: "INVALID_DECISION",
      denyReason: "invalid or missing decision: permission",
    };
  }

  // policy: undefined is INVALID always. "ask" is not a legal policy outcome.
  if (!POLICY_DECISIONS.includes(policy)) {
    return {
      stage: "validate",
      execute: false,
      askUser: false,
      errorCode: "INVALID_DECISION",
      denyReason: "invalid or missing decision: policy",
    };
  }

  // 2. Plugin deny.
  if (plugin === "deny") {
    return {
      stage: "plugin",
      execute: false,
      askUser: false,
      errorCode: "PLUGIN_DENIED",
      denyReason: "plugin policy deny",
    };
  }

  // 3. Policy evaluation (deny-first, mode-aware).
  if (mode === "gate") {
    if (policy === "deny") {
      return {
        stage: "policy",
        execute: false,
        askUser: false,
        errorCode: "POLICY_DENIED",
        denyReason: "gate policy deny",
      };
    }
    if (policy === "not_applicable") {
      // Fail-closed: gate requires an explicit allow.
      return {
        stage: "policy",
        execute: false,
        askUser: false,
        errorCode: "POLICY_UNAVAILABLE",
        denyReason: "gate policy unavailable",
      };
    }
  } else {
    // mode === "direct"
    if (policy === "deny") {
      return {
        stage: "policy",
        execute: false,
        askUser: false,
        errorCode: "POLICY_DENIED",
        denyReason: "direct policy deny",
      };
    }
    // policy === "allow" or "not_applicable" is the normal direct state -> pass.
  }

  // 4. Permission deny.
  if (permission === "deny") {
    return {
      stage: "permission",
      execute: false,
      askUser: false,
      errorCode: "PERMISSION_DENIED",
      denyReason: "permission deny",
    };
  }

  // 5. Ask (only after all deny checks pass). Pending approval, not execution.
  if (permission === "ask" || plugin === "ask") {
    return { stage: "permission", execute: false, askUser: true };
  }

  // 6. All explicitly allowed.
  return { stage: "execute", execute: true, askUser: false };
}
