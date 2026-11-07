/**
 * @typedef {"pending"|"running"|"succeeded"|"failed"|"unknown"} RunState
 * @typedef {Object} ToolTraits
 * @property {boolean} hasSideEffects
 * @property {boolean} reexecutionSafe
 * @typedef {Object} RecoveryStore
 * @property {(id: string) => Promise<void>} commitRunning
 * @property {(id: string, state: RunState) => Promise<void>} commitResult
 */

/**
 * Run an operation with a 2-phase commit split across separate transactions.
 * T1 commits "running" before execution; T2 commits the result afterwards.
 * Execution happens outside any transaction. Fail-closed on crash between phases.
 *
 * @param {{id: string, traits: ToolTraits}} params
 * @param {RecoveryStore} store
 * @param {() => Promise<{ok: boolean}>} execute
 * @returns {Promise<RunState>}
 */
export async function runWithRecovery({ id, traits }, store, execute) {
  await store.commitRunning(id); // T1 - separate transaction
  let outcome;
  try {
    outcome = await execute(); // outside any transaction
  } catch (err) {
    await store.commitResult(id, "failed").catch(() => {});
    throw err;
  }
  const state = outcome.ok ? "succeeded" : "failed";
  await store.commitResult(id, state); // T2 - separate transaction
  return state;
}

/**
 * A run still marked "running" on resume means the process died between T1 and T2.
 * Its true outcome is unknowable, so fail-closed to "unknown".
 *
 * @param {RunState} state
 * @returns {RunState}
 */
export function recoverOnResume(state) {
  return state === "running" ? "unknown" : state;
}

/**
 * Auto-reexecution is safe only for an unknown outcome on a tool with no side
 * effects that is explicitly marked reexecution-safe. Side-effect tools never
 * auto-reexecute, even if marked reexecutionSafe.
 *
 * @param {RunState} state
 * @param {ToolTraits} traits
 * @returns {boolean}
 */
export function canAutoReexecute(state, traits) {
  return state === "unknown" && traits.hasSideEffects === false && traits.reexecutionSafe === true;
}
