/**
 * Phase 4 server execution authorization — execution permit tokens.
 *
 * Gate signs a permit for one tool call with Ed25519; croakcode verifies it
 * right before the tool runs (upstream/packages/opencode/src/delegation/permit.ts).
 * Verification is on with CROAKCODE_EXECUTION_PERMIT=required in gate mode.
 * Protocol: docs/superpowers/architecture/2026-11-09-execution-permit-protocol.md
 *
 * Client-side verification stops a normal client from running a tool without
 * Gate's permit. A tampered client can skip it; enforcing against one needs
 * Gate to reconcile permits with model requests (croak-gate scope).
 *
 * @typedef {Object} PermitRequest
 * @property {string} sid
 * @property {string} pid
 * @property {string} rid
 * @property {string} tool
 * @property {string} args  sha256 hex of the canonical JSON of the tool arguments
 * @property {number} rev
 *
 * @typedef {PermitRequest & {aud: "croakcode", iat: number, exp: number, nonce: string}} PermitPayload
 */
export const SERVER_AUTH_DESCRIPTOR = Object.freeze({
  phase: 4,
  implemented: "client-verification",
  enforcedBy: "gate-signed-permit",
  signature: "ed25519",
  endpoint: "/v1/execution-permits",
  maxTtlMs: 60_000,
  clockSkewMs: 30_000,
  serverReconciliation: "croak-gate",
});
