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

/**
 * @param {unknown} part
 * @returns {boolean}
 */
export function isGateOnlyPart(part) {
  return !!part && typeof part === "object" && /** @type {any} */ (part).metadata?.origin === "gate";
}

/**
 * A part is "unlabeled" when it is an assistant part of a non-text kind that
 * carries no metadata at all. Text parts without metadata are ordinary model
 * output, so they are not dropped. Anything with explicit metadata is judged
 * by `isGateOnlyPart`.
 *
 * @param {any} part
 * @returns {boolean}
 */
function isUnlabeledPart(part) {
  if (!part || typeof part !== "object") return true;
  if (part.type === "text") return false;
  return !part.metadata;
}

/** @param {any} message */
function isUnsafeAssistantMessage(message) {
  const parts = message?.parts ?? [];
  return parts.some((p) => isGateOnlyPart(p) || isUnlabeledPart(p));
}

/**
 * Simple `{ role, parts }` message list (used by tests and plugins).
 * @param {Array<{ role?: string, parts?: any[] }>} messages
 * @param {ConnectionMode} mode
 */
export function filterMessagesForMode(messages, mode) {
  if (mode === "gate") return messages;
  return messages.filter((msg) => {
    if (msg?.role === "user") return true;
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
    if (m?.info?.role !== "assistant") return true;
    return !isUnsafeAssistantMessage(m);
  });
}
