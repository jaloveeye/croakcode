import { afterAll, describe, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadSprite, renderFrame, runIntervalMs, validateSprite, type Sprite } from "./sprite.ts"
import { createLogReader, hitRate, localDay, onDay, speed, speeds, totals, type UsageRecord } from "./usage-log.ts"

const dir = mkdtempSync(path.join(tmpdir(), "usage-panel-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const rec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  v: 1,
  ts: "2026-11-06T01:00:00.000Z",
  sessionID: "s1",
  messageID: "m1",
  agent: "dev-main",
  providerID: "litellm-head",
  modelID: "default",
  finish: "stop",
  tokens: { input: 1000, output: 90, reasoning: 10, cacheRead: 9000, cacheWrite: 0 },
  ttftMs: 1000,
  decodeMs: 2000,
  prefillTps: 1000,
  decodeTps: 50,
  ...over,
})

describe("log reader", () => {
  test("returns only appended complete lines", () => {
    const file = path.join(dir, "usage.jsonl")
    writeFileSync(file, JSON.stringify(rec()) + "\n")
    const reader = createLogReader(file)
    expect(reader.poll()).toHaveLength(1)
    expect(reader.poll()).toHaveLength(0)
    const line = JSON.stringify(rec({ messageID: "m2" }))
    appendFileSync(file, line.slice(0, 20))
    expect(reader.poll()).toHaveLength(0)
    appendFileSync(file, line.slice(20) + "\n")
    expect(reader.poll().map((r) => r.messageID)).toEqual(["m2"])
  })

  test("starts over when the file shrinks", () => {
    const file = path.join(dir, "rotate.jsonl")
    writeFileSync(file, JSON.stringify(rec()) + "\n" + JSON.stringify(rec()) + "\n")
    const reader = createLogReader(file)
    expect(reader.poll()).toHaveLength(2)
    writeFileSync(file, JSON.stringify(rec({ messageID: "new" })) + "\n")
    expect(reader.poll().map((r) => r.messageID)).toEqual(["new"])
  })

  test("returns nothing for a missing file", () => {
    expect(createLogReader(path.join(dir, "none.jsonl")).poll()).toEqual([])
  })
})

describe("aggregation", () => {
  test("speeds weight by tokens and skip missing timings", () => {
    const s = speeds([
      rec(),
      rec({ tokens: { input: 3000, output: 300, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, ttftMs: 1000, prefillTps: 3000, decodeMs: 3000, decodeTps: 100 }),
      rec({ ttftMs: null, prefillTps: null, decodeMs: null, decodeTps: null }),
    ])
    expect(s.avgPrefill).toBe(2000)
    expect(s.avgDecode).toBe(80)
    expect(s.lastPrefill).toBe(3000)
    expect(s.lastDecode).toBe(100)
    expect(s.minPrefill).toBe(1000)
    expect(s.maxPrefill).toBe(3000)
    expect(s.minDecode).toBe(50)
    expect(s.maxDecode).toBe(100)
  })

  test("speeds leave min/max empty without timings", () => {
    const s = speeds([rec({ ttftMs: null, prefillTps: null, decodeMs: null, decodeTps: null })])
    expect(s.minPrefill).toBeNull()
    expect(s.maxPrefill).toBeNull()
    expect(s.minDecode).toBeNull()
    expect(s.maxDecode).toBeNull()
  })

  test("speed formats compactly for the sidebar", () => {
    expect(speed(null)).toBe("-")
    expect(speed(50)).toBe("50.0")
    expect(speed(1000)).toBe("1.0K")
    expect(speed(2000)).toBe("2.0K")
  })

  test("totals and cache hit rate", () => {
    const t = totals([rec(), rec()])
    expect(t).toEqual({ requests: 2, input: 2000, output: 180, reasoning: 20, cacheRead: 18000, cacheWrite: 0 })
    expect(hitRate(t)).toBe(0.9)
    expect(hitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull()
  })

  test("onDay uses the local calendar day", () => {
    const now = new Date(2026, 10, 6, 9, 0, 0)
    const yesterday = new Date(2026, 10, 5, 23, 59, 0)
    const list = [rec({ ts: now.toISOString() }), rec({ ts: yesterday.toISOString() })]
    expect(onDay(list, localDay(now))).toHaveLength(1)
  })
})

describe("sprite", () => {
  const sprite = loadSprite(path.join(import.meta.dir, "sprites", "gatebot.json"))

  test("bundled sprite is valid and renders half-height rows", () => {
    const rows = renderFrame(sprite, sprite.frames[0])
    expect(rows).toHaveLength(sprite.height / 2)
    for (const row of rows) expect(row.map((c) => c.text).join("")).toHaveLength(sprite.width)
  })

  test("bundled frieren sprite is valid and covers every animation", () => {
    const frieren = loadSprite(path.join(import.meta.dir, "sprites", "frieren.json"))
    expect(frieren.name).toBe("frieren")
    expect(frieren.width).toBe(16)
    expect(frieren.height % 2).toBe(0)
    expect(frieren.frames).toHaveLength(10)
    expect(Object.keys(frieren.animations).sort()).toEqual(["ask", "dizzy", "idle", "run", "sleep", "think"])
    for (const animation of Object.values(frieren.animations)) {
      for (const frame of animation.sequence) expect(frieren.frames[frame]).toBeDefined()
    }
    for (const frame of frieren.frames) expect(renderFrame(frieren, frame)).toHaveLength(frieren.height / 2)
  })

  test("renderFrame picks half blocks and merges equal cells", () => {
    const s: Sprite = {
      name: "t",
      width: 4,
      height: 2,
      palette: { a: "#111111", b: "#222222" },
      frames: [["aa.a", "ab.."]],
      animations: { idle: { fps: 1, sequence: [0] }, think: { fps: 1, sequence: [0] }, run: { fps: 1, sequence: [0] } },
    }
    expect(renderFrame(s, s.frames[0])).toEqual([
      [
        { text: "█", fg: "#111111" },
        { text: "▀", fg: "#111111", bg: "#222222" },
        { text: " " },
        { text: "▀", fg: "#111111" },
      ],
    ])
  })

  test("renderFrame can downscale for a compact avatar", () => {
    const rows = renderFrame(sprite, sprite.frames[0], sprite.palette, 0.5)
    expect(rows).toHaveLength(4)
    for (const row of rows) expect(row.map((c) => c.text).join("")).toHaveLength(8)
    const treefrog = loadSprite(path.join(import.meta.dir, "sprites", "treefrog.json"))
    const frog = renderFrame(treefrog, treefrog.frames[0], treefrog.palette, 0.5)
    expect(frog).toHaveLength(5)
    for (const row of frog) expect(row.map((c) => c.text).join("")).toHaveLength(10)
    // 0.9 of 20x18 is 18x16 pixels: 8 text rows of 18 cells.
    const slim = renderFrame(treefrog, treefrog.frames[0], treefrog.palette, 0.9)
    expect(slim).toHaveLength(8)
    for (const row of slim) expect(row.map((c) => c.text).join("")).toHaveLength(18)
    expect(renderFrame(treefrog, treefrog.frames[0], treefrog.palette, 1)).toHaveLength(9)
  })

  test("validateSprite rejects bad rows and colors", () => {
    const bad = { ...sprite, frames: [["x".repeat(16), ...sprite.frames[0].slice(1)]] }
    expect(() => validateSprite(bad)).toThrow()
  })

  test("run interval speeds up with decode speed", () => {
    expect(runIntervalMs(null, 8)).toBe(125)
    expect(runIntervalMs(10, 8)).toBe(250)
    expect(runIntervalMs(40, 8)).toBe(100)
    expect(runIntervalMs(1000, 8)).toBe(60)
  })
})
