/**
 * @typedef {Object} ChatRequest
 * @property {string} model
 * @property {unknown[]} messages
 * @property {ToolSpec[]} [tools]
 * @property {Record<string, unknown>} params
 * @property {Record<string, string>} headers
 *
 * @typedef {Object} ToolSpec
 * @property {string} name
 * @property {string} [description]
 * @property {unknown} [schema]
 * @property {boolean} hasSideEffects
 * @property {boolean} reexecutionSafe
 * @property {boolean} [requiresAuth]
 *
 * @typedef {Object} Delta
 * One of: text | tool_call.start | tool_call.delta | tool_call.completed | usage | reasoning | stop | error
 *
 * @typedef {Object} ConnectionAdapter
 * @property {"gate"|"direct"} id
 * @property {(req: ChatRequest) => Promise<ChatRequest>} prepare
 * @property {(req: ChatRequest, signal: AbortSignal) => AsyncIterable<Delta>} stream
 * @property {() => boolean} requiresAuthorization
 * @property {() => (null | ((tool: string, sessionID: string) => Promise<"allow"|"deny">))} policyHook
 */

export const DELTA_KINDS = Object.freeze([
  "text",
  "tool_call.start",
  "tool_call.delta",
  "tool_call.completed",
  "usage",
  "reasoning",
  "stop",
  "error",
]);

export const TOOL_SPEC_REQUIRED = Object.freeze(["name", "hasSideEffects", "reexecutionSafe"]);
