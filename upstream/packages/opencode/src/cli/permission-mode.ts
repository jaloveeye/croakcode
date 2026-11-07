export type PermissionMode = "ask" | "auto"

export function togglePermissionMode(mode: PermissionMode): PermissionMode {
  return mode === "ask" ? "auto" : "ask"
}
