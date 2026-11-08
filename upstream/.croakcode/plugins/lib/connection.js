// Connection mode helpers shared by the runtime and the plugin boundary.
//
// `resolveConnectionMode` implements spec §5.3 precedence (agent.force >
// session override > global connection.mode) and is fail-closed: any value that
// is not exactly "gate" or "direct" resolves to "gate".
//
// The two filters implement the direct-mode context rule: when a session talks
// straight to the provider instead of the gate, assistant history that was
// produced or tagged by the gate (`metadata.origin === "gate"`) must not be sent
// back, and assistant parts whose provenance is unknown are dropped as well.
// User turns are user input, so they are always kept.
//
// Imported by `src/session/llm/mode.ts` and `src/session/prompt.ts` (the real
// request path) as well as by the plugin libs, so this file must stay plain ESM
// with no external dependencies.
import { resolveEffectiveMode } from "@croakcode/control";

/**
 * @typedef {"gate"|"direct"} ConnectionMode
 */

/**
 * Resolve the effective connection mode. Never throws; always returns a mode.
 *
 * @param {{ agentForce?: unknown, session?: unknown, global?: unknown }} input
 * @returns {ConnectionMode}
 */
export function resolveConnectionMode({ agentForce, session, global } = {}) {
  const r = resolveEffectiveMode({
    agentForce: asMode(agentForce),
    sessionOverride: asMode(session),
    global: asMode(global),
  });
  if (r.mode === "gate" || r.mode === "direct") return r.mode;
  // fail-safe: 권한이 더 엄격한 gate로 떨어진다.
  return "gate";
}

function asMode(value) {
  return value === "gate" || value === "direct" ? value : undefined;
}

/** Trusted provenance values the runtime may stamp on a persisted part. */
export const TRUSTED_ORIGINS = Object.freeze(["gate", "user"]);

/**
 * Stamp a trusted provenance value on a part's metadata.
 *
 * SEC-03: the runtime — not the provider or the model — decides where a part
 * came from. A pre-existing `metadata.origin` (which a provider could set via
 * `providerMetadata`) must never win, so this always overwrites it. All other
 * metadata keys are preserved.
 *
 * @param {any} part
 * @param {"gate"|"user"} origin
 * @returns {any} the same part with the trusted stamp
 */
export function markOrigin(part, origin) {
  if (!part || typeof part !== "object") return part;
  if (!TRUSTED_ORIGINS.includes(origin)) {
    throw new Error(`markOrigin: refusing to stamp untrusted origin ${String(origin)}`);
  }
  part.metadata = { ...(part.metadata ?? {}), origin };
  return part;
}

/**
 * True when a part's declared origin is missing or not one of the trusted
 * values. Such parts cannot be proven safe to replay to a direct provider.
 *
 * @param {any} part
 * @returns {boolean}
 */
export function isUntrustedOrigin(part) {
  const origin = part && typeof part === "object" ? part.metadata?.origin : undefined;
  return !TRUSTED_ORIGINS.includes(origin);
}

/**
 * @param {unknown} part
 * @returns {boolean}
 */
export function isGateOnlyPart(part) {
  return !!part && typeof part === "object" && /** @type {any} */ (part).metadata?.origin === "gate";
}

/**
 * An assistant part that must not be replayed to a direct provider:
 * gate-produced (`origin:"gate"`) or of unprovable provenance (fail-closed).
 * Explicitly user-trusted parts (`origin:"user"`) are safe.
 *
 * @param {any} part
 * @returns {boolean}
 */
export function isProtectedAssistantPart(part) {
  return isGateOnlyPart(part) || isUntrustedOrigin(part);
}

/** @param {any} message */
function isUnsafeAssistantMessage(message) {
  const parts = message?.parts ?? [];
  return parts.some(isProtectedAssistantPart);
}

/**
 * Simple `{ role, parts }` message list (used by tests and plugins).
 * @param {Array<{ role?: string, parts?: any[] }>} messages
 * @param {ConnectionMode} mode
 */
export function filterMessagesForMode(messages, mode) {
  if (mode === "gate") return messages;
  return messages.filter((msg) => {
    if (msg?.role === "user") {
      // SEC-03: withhold a synthetic user turn carrying gate-stamped sub-agent
      // output; genuine user input (untagged / origin:"user") is kept.
      return !(msg?.parts ?? []).some(isGateOnlyPart);
    }
    return !isUnsafeAssistantMessage(msg);
  });
}

/**
 * MessageV2 messages (`{ info: { role }, parts }`) — the shape the runtime
 * converts into model messages. Same rule as `filterMessagesForMode`.
 *
 * @template {any} M
 * @param {M[]} messages
 * @param {ConnectionMode} mode
 * @returns {M[]}
 */
export function filterMessagesForModeParts(messages, mode) {
  if (mode === "gate") return messages;
  return messages.filter((m) => {
    const role = m?.info?.role;
    if (role === "assistant") return !isUnsafeAssistantMessage(m);
    // SEC-03: user-role turns are normally trusted (genuine user input is never
    // removed). But a synthetic user message can carry sub-agent output injected
    // by the runtime, so only an explicitly gate-stamped part is withheld. An
    // untagged user part stays trusted to avoid over-removing real user input.
    if (role === "user") {
      const parts = m?.parts ?? [];
      return !parts.some(isGateOnlyPart);
    }
    return true;
  });
}
