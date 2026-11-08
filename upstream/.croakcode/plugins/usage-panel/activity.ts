// Current-turn state for the prompt timer and the avatar speech bubble.
// Both callers derive from the same session state with the same rules, so the
// two displays stay consistent.
import { createMemo, createSignal, onCleanup } from "solid-js"
import { GUARD_MARK, type Guard } from "./controller.tsx"
import { activityLabel, formatElapsed, openTool, turnWindow } from "./elapsed.ts"

/** Tokens arriving within this window count as streaming. */
export const STREAM_WINDOW_MS = 1500
const BUSY_TICK_MS = 50
const IDLE_TICK_MS = 1000

export function createActivity(api: any, sessionID: string, guard?: Guard) {
  const [now, setNow] = createSignal(Date.now())
  const [lastDelta, setLastDelta] = createSignal<{ kind: "reasoning" | "text"; at: number }>()
  const kinds = new Map<string, "reasoning" | "text">()

  // Millisecond display: tick fast while the session works, slowly while idle.
  let clock: ReturnType<typeof setTimeout>
  const tick = () => {
    setNow(Date.now())
    clock = setTimeout(tick, busy() ? BUSY_TICK_MS : IDLE_TICK_MS)
  }
  clock = setTimeout(tick, 0)
  const offs = [
    api.event.on("message.part.updated", (e: any) => {
      const part = e.properties.part
      if (part?.sessionID === sessionID && (part.type === "text" || part.type === "reasoning")) {
        kinds.set(part.id, part.type)
      }
    }),
    api.event.on("message.part.delta", (e: any) => {
      const p = e.properties
      if (p.sessionID !== sessionID || p.field !== "text") return
      setLastDelta({ kind: kinds.get(p.partID) ?? "text", at: Date.now() })
    }),
  ]
  onCleanup(() => {
    clearTimeout(clock)
    offs.forEach((off: () => void) => off())
  })

  const busy = () => {
    const type = api.state.session.status(sessionID)?.type
    return type === "busy" || type === "retry"
  }
  const turn = createMemo(() =>
    turnWindow(
      api.state.session.messages(sessionID),
      (id: string) => api.state.part(id),
      (text: string) => text.startsWith(GUARD_MARK),
      busy(),
    ),
  )
  const tool = createMemo(() => {
    const msgs = api.state.session.messages(sessionID)
    const last = msgs.findLast?.((m: any) => m.role === "assistant")
    return last ? openTool(api.state.part(last.id)) : undefined
  })
  const waiting = () =>
    (api.state.session.permission?.(sessionID) ?? []).length
      ? ("permission" as const)
      : (api.state.session.question?.(sessionID) ?? []).length
        ? ("question" as const)
        : undefined
  const label = () =>
    activityLabel({
      busy: busy(),
      guard: guard?.states()[sessionID]?.kind,
      lastDelta: lastDelta(),
      openTool: tool(),
      waiting: waiting(),
      now: now(),
      streamWindowMs: STREAM_WINDOW_MS,
    })
  const elapsed = () => {
    const w = turn()
    return w ? formatElapsed((w.end ?? now()) - w.start) : null
  }

  return { now, busy, turn, label, elapsed }
}
