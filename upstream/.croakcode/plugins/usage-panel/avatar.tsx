/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, onCleanup } from "solid-js"
import { fallbackAnimation, modeLook, renderFrame, runIntervalMs, type AnimationName, type Cell, type Sprite } from "./sprite.ts"

/**
 * Animated sprite. `think` plays while the model is busy without output
 * (prefill), `run` plays while tokens stream at a pace that follows decode
 * speed, and `sleep`, `dizzy` and `ask` show guard states.
 */
export function Avatar(props: {
  sprite: Sprite
  animation: () => AnimationName
  decodeTps: () => number | null
  onClick?: () => void
  /** Look from the sprite's `modes`, for example the approval mode. */
  mode?: () => string | undefined
  /** Size ratio of the picture, for example 0.9. */
  scale?: number
}) {
  // Rendered once per mode; switching modes only swaps the cached frames.
  const cache = new Map<string, Cell[][][]>()
  const rendered = (mode?: string) => {
    const key = mode && props.sprite.modes?.[mode] ? mode : ""
    let frames = cache.get(key)
    if (!frames) {
      frames = props.sprite.frames.map((f) => {
        const look = modeLook(props.sprite, f, key || undefined)
        return renderFrame(props.sprite, look.frame, look.palette, props.scale)
      })
      cache.set(key, frames)
    }
    return frames
  }
  const [step, setStep] = createSignal(0)
  let timer: ReturnType<typeof setTimeout> | undefined
  let last: AnimationName | undefined

  const interval = () => {
    const name = props.animation()
    const anim = fallbackAnimation(props.sprite, name)
    return name === "run" ? runIntervalMs(props.decodeTps(), anim.fps) : Math.round(1000 / anim.fps)
  }

  const tick = () => {
    const name = props.animation()
    if (name !== last) {
      last = name
      setStep(0)
    } else {
      setStep((s) => s + 1)
    }
    timer = setTimeout(tick, interval())
  }
  timer = setTimeout(tick, interval())
  onCleanup(() => clearTimeout(timer))

  const rows = createMemo(() => {
    const seq = fallbackAnimation(props.sprite, props.animation()).sequence
    return rendered(props.mode?.())[seq[step() % seq.length]]
  })

  return (
    <box flexShrink={0} onMouseUp={() => props.onClick?.()}>
      <For each={rows()}>
        {(row) => (
          // A wrapped row breaks the picture; keep every row on one line.
          <text wrapMode="none" flexShrink={0}>
            <For each={row}>{(cell) => <span style={{ fg: cell.fg, bg: cell.bg }}>{cell.text}</span>}</For>
          </text>
        )}
      </For>
    </box>
  )
}
