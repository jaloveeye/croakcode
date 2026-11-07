/**
 * @typedef {Object} PluginHooks
 * @property {(input: {headers: Record<string,string>}) => Promise<void>} [chat.headers]
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
