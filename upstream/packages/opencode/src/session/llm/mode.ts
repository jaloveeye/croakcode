import {
  resolveConnectionMode,
  filterMessagesForModeParts,
  markOrigin,
  containsGateContext,
} from "../../../../../.croakcode/plugins/lib/connection.js"

export type ConnectionMode = "gate" | "direct"

// Resolves the effective connection mode for a request, applying the spec §5.3
// precedence over the config value. `agent.force` is not a field on Agent.Info
// yet (phase 4), so only the session/global config signal is consulted here.
export function connectionFor(config: { connection?: { mode?: unknown } } | undefined): {
  mode: ConnectionMode
} {
  return { mode: resolveConnectionMode({ global: config?.connection?.mode }) }
}

// Trusted provenance for content produced under `connection`.
export function originFor(connection: { mode: ConnectionMode }): "gate" | "user" {
  return connection.mode === "gate" ? "gate" : "user"
}

// Re-exported so the request path imports the exact same implementation the
// plugin-side tests exercise (single source of truth, no copy).
export { filterMessagesForModeParts, markOrigin, containsGateContext }
