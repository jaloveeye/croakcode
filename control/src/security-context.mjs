/**
 * @typedef {"gate"|"direct"} Mode
 * @typedef {Object} ResolveEffectiveModeInput
 * @property {Mode} [agentForce]
 * @property {Mode} [sessionOverride]
 * @property {Mode} [global]
 * @property {boolean} [requiresAuth]
 * @typedef {Object} EffectiveModeResult
 * @property {Mode|undefined} mode
 * @property {boolean} ok
 * @property {string} [warning]
 * @property {string} [error]
 */

/**
 * Resolve the effective security mode using spec §5.3 precedence
 * (highest -> lowest): agent.force > session override > global connection.mode.
 * There is NO auto-upgrade to gate.
 *
 * @param {ResolveEffectiveModeInput} input
 * @returns {EffectiveModeResult}
 */
export function resolveEffectiveMode({ agentForce, sessionOverride, global, requiresAuth } = {}) {
  // 1. Precedence: agent.force > session override > global.
  let mode = agentForce ?? sessionOverride ?? global;
  let warning;

  // 2. Forced gate beats a direct request, but flag it: it overrode direct.
  if (agentForce === "gate" && (sessionOverride === "direct" || global === "direct")) {
    mode = "gate";
    warning = "agent.force gate overrides direct mode; effective mode forced to gate";
  }

  // Fail-closed on an unresolvable mode: no signal at any precedence level.
  if (mode !== "gate" && mode !== "direct") {
    return {
      mode,
      ok: false,
      ...(warning ? { warning } : {}),
      error: "invalid or missing mode: no agent.force, session override, or global mode resolved",
    };
  }

  // 3. requiresAuth demands gate; fail-closed, no auto-upgrade.
  if (requiresAuth && mode !== "gate") {
    return {
      mode,
      ok: false,
      ...(warning ? { warning } : {}),
      error: "this action requires gate mode; no auto-upgrade is performed",
    };
  }

  // 4. Otherwise fine.
  return { mode, ok: true, ...(warning ? { warning } : {}) };
}
