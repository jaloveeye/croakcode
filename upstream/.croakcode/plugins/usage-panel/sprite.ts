// Pixel sprites drawn with half-block characters: one text row holds two pixel rows.
import { readFileSync } from "node:fs"

export type SpriteAnimation = {
  /** Frames per second; the `run` animation is rescaled by decode speed. */
  fps: number
  /** Indexes into `frames`. */
  sequence: number[]
}

export type Sprite = {
  name: string
  width: number
  height: number
  /** One character per pixel color; `.` is transparent. */
  palette: Record<string, string>
  frames: string[][]
  animations: {
    idle: SpriteAnimation
    think: SpriteAnimation
    run: SpriteAnimation
    /** Optional guard states; missing ones fall back to `fallbackAnimation`. */
    sleep?: SpriteAnimation
    dizzy?: SpriteAnimation
    ask?: SpriteAnimation
    /** Something was blocked (plugin or gate). Falls back to `ask`. */
    alert?: SpriteAnimation
  }
  /**
   * Optional looks per mode (for example the approval mode "auto"): palette
   * colors to replace and pixels to draw over every frame as [y, x, color].
   */
  modes?: Record<string, SpriteMode>
}

export type SpriteMode = { palette?: Record<string, string>; overlay?: [number, number, string][] }

export type AnimationName = keyof Sprite["animations"]

const FALLBACK: Record<AnimationName, AnimationName> = {
  idle: "idle",
  think: "think",
  run: "run",
  sleep: "idle",
  dizzy: "think",
  ask: "think",
  alert: "ask",
}

/** The animation to play for `name`, falling back for optional ones the sprite lacks. */
export function fallbackAnimation(s: Sprite, name: AnimationName): SpriteAnimation {
  // Follow the chain (alert -> ask -> think) until the sprite has one.
  for (let n = name, i = 0; i < 5; n = FALLBACK[n], i++) {
    const anim = s.animations[n]
    if (anim) return anim
  }
  return s.animations.idle
}

export type Cell = { text: string; fg?: string; bg?: string }

export function loadSprite(file: string): Sprite {
  const sprite = JSON.parse(readFileSync(file, "utf8")) as Sprite
  validateSprite(sprite)
  return sprite
}

export function validateSprite(s: Sprite) {
  if (s.height % 2 !== 0) throw new Error(`sprite ${s.name}: height must be even`)
  s.frames.forEach((frame, i) => {
    if (frame.length !== s.height) throw new Error(`sprite ${s.name}: frame ${i} has ${frame.length} rows`)
    frame.forEach((row, y) => {
      if (row.length !== s.width) throw new Error(`sprite ${s.name}: frame ${i} row ${y} has ${row.length} pixels`)
      for (const ch of row) {
        if (ch !== "." && !(ch in s.palette)) throw new Error(`sprite ${s.name}: unknown color '${ch}'`)
      }
    })
  })
  for (const [mode, look] of Object.entries(s.modes ?? {})) {
    for (const [y, x, ch] of look.overlay ?? []) {
      if (y < 0 || y >= s.height || x < 0 || x >= s.width) throw new Error(`sprite ${s.name}: mode ${mode} overlay outside the frame`)
      if (!(ch in s.palette) && !(ch in (look.palette ?? {}))) throw new Error(`sprite ${s.name}: mode ${mode} unknown color '${ch}'`)
    }
  }
  for (const required of ["idle", "think", "run"] as const) {
    if (!s.animations[required]) throw new Error(`sprite ${s.name}: missing animation ${required}`)
  }
  for (const [name, anim] of Object.entries(s.animations)) {
    if (!anim) continue
    if (!anim.sequence.length || anim.sequence.some((i) => i < 0 || i >= s.frames.length)) {
      throw new Error(`sprite ${s.name}: animation ${name} has a bad sequence`)
    }
  }
}

/** Frame and palette for a mode; unknown modes use the base look. */
export function modeLook(s: Sprite, frame: string[], mode?: string): { frame: string[]; palette: Record<string, string> } {
  const look = mode ? s.modes?.[mode] : undefined
  if (!look) return { frame, palette: s.palette }
  const rows = frame.map((r) => r.split(""))
  for (const [y, x, ch] of look.overlay ?? []) rows[y][x] = ch
  return { frame: rows.map((r) => r.join("")), palette: { ...s.palette, ...look.palette } }
}

/** Details worth keeping when a 2x2 block is reduced to one pixel. */
const SCALE_PRIORITY = ["P", "V", "Z", "Q", "W", "K"]

/**
 * Shrinks the pixel grid to `ratio` of its size (0 < ratio < 1). Each target
 * pixel covers a block of source pixels; a telling colour in SCALE_PRIORITY
 * wins, otherwise the most common one. The height is kept even.
 */
function downscale(frame: string[], width: number, height: number, ratio: number) {
  const w = Math.max(1, Math.round(width * ratio))
  const h = Math.max(1, Math.round(height * ratio))
  const span = (i: number, from: number, to: number) => {
    const a = Math.floor((i * from) / to)
    return [a, Math.max(a + 1, Math.floor(((i + 1) * from) / to))] as const
  }
  const rows: string[] = []
  for (let y = 0; y < h; y++) {
    const [y0, y1] = span(y, height, h)
    let row = ""
    for (let x = 0; x < w; x++) {
      const [x0, x1] = span(x, width, w)
      const counts = new Map<string, number>()
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const px = frame[sy]?.[sx]
          if (px && px !== ".") counts.set(px, (counts.get(px) ?? 0) + 1)
        }
      }
      let best = SCALE_PRIORITY.find((ch) => counts.has(ch)) ?? "."
      if (best === "." && counts.size) {
        let n = 0
        for (const [ch, c] of counts) {
          if (c > n) {
            best = ch
            n = c
          }
        }
      }
      row += best
    }
    rows.push(row)
  }
  if (rows.length % 2) rows.push(".".repeat(w))
  return { frame: rows, width: w, height: rows.length }
}

/** Converts one frame into text rows of styled cells, merging equal neighbours. */
export function renderFrame(
  s: Sprite,
  frame: string[],
  palette: Record<string, string> = s.palette,
  /** Size ratio, for example 0.9. Values of 1 or more keep the original size. */
  scale = 1,
): Cell[][] {
  let width = s.width
  let height = s.height
  if (scale > 0 && scale < 1) {
    const small = downscale(frame, width, height, scale)
    frame = small.frame
    width = small.width
    height = small.height
  }
  const rows: Cell[][] = []
  for (let y = 0; y < height; y += 2) {
    const top = frame[y]
    const bottom = frame[y + 1] ?? ".".repeat(width)
    const cells: Cell[] = []
    for (let x = 0; x < width; x++) {
      const t = top[x] === "." ? undefined : palette[top[x]]
      const b = bottom[x] === "." ? undefined : palette[bottom[x]]
      let cell: Cell
      if (!t && !b) cell = { text: " " }
      else if (t && !b) cell = { text: "▀", fg: t }
      else if (!t && b) cell = { text: "▄", fg: b }
      else if (t === b) cell = { text: "█", fg: t }
      else cell = { text: "▀", fg: t, bg: b }
      const prev = cells.at(-1)
      if (prev && prev.fg === cell.fg && prev.bg === cell.bg && prev.text[0] === cell.text) prev.text += cell.text
      else cells.push(cell)
    }
    rows.push(cells)
  }
  return rows
}

/**
 * Frame interval for the run animation. Faster decoding runs faster, like a
 * CPU meter: 10 tok/s ≈ 250 ms, 40 tok/s ≈ 100 ms, floor 60 ms.
 */
export function runIntervalMs(decodeTps: number | null, baseFps: number) {
  if (decodeTps === null || !Number.isFinite(decodeTps) || decodeTps <= 0) return Math.round(1000 / baseFps)
  return Math.round(Math.min(500, Math.max(60, 1000 / (2 + decodeTps / 5))))
}
