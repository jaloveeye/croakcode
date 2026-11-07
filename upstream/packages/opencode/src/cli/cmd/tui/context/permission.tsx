import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { createSignal, onCleanup } from "solid-js"
import { togglePermissionMode, type PermissionMode } from "@/cli/permission-mode"
import { createSimpleContext } from "./helper"
import { useEvent } from "./event"
import { useSDK } from "./sdk"

export const { use: usePermissionMode, provider: PermissionModeProvider } = createSimpleContext({
  name: "PermissionMode",
  init: (props: { autoApprove?: boolean }) => {
    const sdk = useSDK()
    const event = useEvent()
    const pending = new Map<string, PermissionRequest>()
    const replying = new Set<string>()
    const [mode, setValue] = createSignal<PermissionMode>(props.autoApprove ? "auto" : "ask")

    const approve = (request: PermissionRequest) => {
      if (mode() !== "auto" || replying.has(request.id)) return
      replying.add(request.id)
      void sdk.client.permission
        .reply({
          requestID: request.id,
          reply: "once",
        })
        .catch(() => {})
        .finally(() => {
          replying.delete(request.id)
        })
    }

    const off = event.subscribe((item) => {
      if (item.type === "permission.asked") {
        pending.set(item.properties.id, item.properties)
        approve(item.properties)
        return
      }

      if (item.type !== "permission.replied") return
      pending.delete(item.properties.requestID)
      replying.delete(item.properties.requestID)
    })
    onCleanup(off)

    const set = (next: PermissionMode) => {
      setValue(next)
      if (next === "auto") pending.forEach(approve)
      return next
    }

    return {
      mode,
      set,
      toggle() {
        return set(togglePermissionMode(mode()))
      },
    }
  },
})
