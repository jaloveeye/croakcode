/**
 * `chat.headers` input carries the effective connection mode so plugins that
 * hold a gate-only credential can decide whether to attach it.
 *
 * Protected-header contract (croak-auth, §5.4): attach the gate token ONLY when
 * all three conditions hold —
 *   1. provider id is one of CROAK_PROVIDERS,
 *   2. the provider baseURL origin equals the gate/auth origin,
 *   3. `connection.mode === "gate"`.
 * A missing or unknown mode is NOT gate: treat it as fail-closed (no token),
 * and in `direct` mode also drop gate-origin assistant history from the request.
 *
 * @typedef {Object} ChatHeadersInput
 * @property {{mode: "gate"|"direct"}} [connection]
 *
 * @typedef {Object} PluginHooks
 * @property {(input: ChatHeadersInput & {headers: Record<string,string>}) => Promise<void>} [chat.headers]
 * @property {(input: {params: Record<string,unknown>}) => Promise<void>} [chat.params]
 * @property {(input: ToolBeforeInput) => Promise<"allow"|"deny"|"ask"|void>} [tool.execute.before]
 * @property {(input: ToolAfterInput) => Promise<void>} [tool.execute.after]
 * @property {(input: CommandInput) => Promise<void>} [command.execute.before]
 * @property {(input: {event: unknown}) => Promise<void>} [event]
 *
 * @typedef {{tool: string, args: unknown, sessionID: string}} ToolBeforeInput
 * @typedef {{tool: string, result: unknown, sessionID: string}} ToolAfterInput
 * @typedef {{command: string, sessionID: string, arguments: string[]}} CommandInput
 */

export const HOOK_NAMES = Object.freeze([
  "chat.headers",
  "chat.params",
  "tool.execute.before",
  "tool.execute.after",
  "command.execute.before",
  "event",
]);
