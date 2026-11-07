/**
 * Phase 4 server execution authorization — INTERFACE DRAFT ONLY.
 * Phase 1-3 rely on local policy enforcement (spec §5.4). No enforcement here.
 *
 * @typedef {Object} ServerVerdict
 * @property {boolean} allowed
 * @property {string} [reason]
 *
 * @typedef {(req: {tool: string, sessionID: string, mode: "gate"|"direct"}) => Promise<ServerVerdict>} ServerVerifier
 */
export const SERVER_AUTH_DESCRIPTOR = Object.freeze({
  phase: 4,
  implemented: false,
  enforcedBy: "local-in-phases-1-3",
});
