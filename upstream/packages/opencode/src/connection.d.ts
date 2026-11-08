// The connection-mode helpers live in the config directory next to the plugins
// that also use them (`upstream/.croakcode/plugins/lib/connection.js`) so the
// runtime and the plugins share one implementation. `tsgo --noEmit` does not
// follow imports that leave the package root, so the runtime side declares the
// module here. The shapes match `plugins/lib/connection.js`; keep them in sync.
declare module "*/connection.js" {
  export type ConnectionMode = "gate" | "direct"

  export function resolveConnectionMode(input?: {
    agentForce?: unknown
    session?: unknown
    global?: unknown
  }): ConnectionMode

  export function isGateOnlyPart(part: unknown): boolean

  export function filterMessagesForMode<T extends { role?: string; parts?: any[] }>(
    messages: T[],
    mode: ConnectionMode,
  ): T[]

  export function filterMessagesForModeParts<T>(messages: T[], mode: ConnectionMode): T[]
}
