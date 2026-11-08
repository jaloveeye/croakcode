// Reads the JSONL written by usage-meter.mjs and aggregates it.
import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export type UsageRecord = {
  v: number
  ts: string
  sessionID: string
  messageID: string
  agent: string | null
  providerID: string | null
  modelID: string | null
  finish: string | null
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  ttftMs: number | null
  decodeMs: number | null
  prefillTps: number | null
  decodeTps: number | null
}

export const usageFile = () =>
  process.env.CROAK_USAGE_FILE ||
  path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "croak", "usage.jsonl")

/** Only the tail of a large log is read at startup. */
const INITIAL_TAIL_BYTES = 8 * 1024 * 1024
const MAX_RECORDS = 50_000

/** Incremental reader: each `poll()` returns records appended since the last call. */
export function createLogReader(file = usageFile()) {
  let offset = -1
  let carry = ""

  return {
    poll(): UsageRecord[] {
      let fd: number
      try {
        fd = openSync(file, "r")
      } catch {
        return []
      }
      try {
        const size = fstatSync(fd).size
        if (offset < 0) {
          offset = Math.max(0, size - INITIAL_TAIL_BYTES)
          carry = ""
        }
        if (size < offset) {
          // Truncated or rotated.
          offset = 0
          carry = ""
        }
        if (size === offset) return []
        const buf = Buffer.alloc(size - offset)
        readSync(fd, buf, 0, buf.length, offset)
        offset = size
        const text = carry + buf.toString("utf8")
        const lines = text.split("\n")
        carry = lines.pop() ?? ""
        return parseLines(lines)
      } finally {
        closeSync(fd)
      }
    },
  }
}

export function parseLines(lines: string[]): UsageRecord[] {
  const out: UsageRecord[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (r && r.v === 1 && r.tokens) out.push(r)
    } catch {
      // A partial first line after a tail read is expected.
    }
  }
  return out
}

export function appendCapped(list: UsageRecord[], more: UsageRecord[]) {
  const next = list.concat(more)
  return next.length > MAX_RECORDS ? next.slice(next.length - MAX_RECORDS) : next
}

export type Speeds = {
  lastPrefill: number | null
  lastDecode: number | null
  avgPrefill: number | null
  avgDecode: number | null
  minPrefill: number | null
  maxPrefill: number | null
  minDecode: number | null
  maxDecode: number | null
  lastTtftMs: number | null
}

/** Averages weight by tokens: total tokens over total time. */
export function speeds(records: UsageRecord[]): Speeds {
  let pTok = 0
  let pMs = 0
  let dTok = 0
  let dMs = 0
  let lastPrefill: number | null = null
  let lastDecode: number | null = null
  let minPrefill: number | null = null
  let maxPrefill: number | null = null
  let minDecode: number | null = null
  let maxDecode: number | null = null
  let lastTtftMs: number | null = null
  for (const r of records) {
    if (r.prefillTps !== null && r.ttftMs) {
      pTok += r.tokens.input
      pMs += r.ttftMs
      lastPrefill = r.prefillTps
      lastTtftMs = r.ttftMs
      minPrefill = minPrefill === null ? r.prefillTps : Math.min(minPrefill, r.prefillTps)
      maxPrefill = maxPrefill === null ? r.prefillTps : Math.max(maxPrefill, r.prefillTps)
    }
    if (r.decodeTps !== null && r.decodeMs) {
      dTok += r.tokens.output + r.tokens.reasoning
      dMs += r.decodeMs
      lastDecode = r.decodeTps
      minDecode = minDecode === null ? r.decodeTps : Math.min(minDecode, r.decodeTps)
      maxDecode = maxDecode === null ? r.decodeTps : Math.max(maxDecode, r.decodeTps)
    }
  }
  return {
    lastPrefill,
    lastDecode,
    avgPrefill: pMs > 0 ? (pTok / pMs) * 1000 : null,
    avgDecode: dMs > 0 ? (dTok / dMs) * 1000 : null,
    minPrefill,
    maxPrefill,
    minDecode,
    maxDecode,
    lastTtftMs,
  }
}

export type Totals = { requests: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }

export function totals(records: Iterable<{ tokens: UsageRecord["tokens"] }>): Totals {
  const t: Totals = { requests: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  for (const r of records) {
    t.requests++
    t.input += r.tokens.input
    t.output += r.tokens.output
    t.reasoning += r.tokens.reasoning
    t.cacheRead += r.tokens.cacheRead
    t.cacheWrite += r.tokens.cacheWrite
  }
  return t
}

/** Local calendar day, `YYYY-MM-DD`. */
export function localDay(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function onDay(records: UsageRecord[], day: string) {
  return records.filter((r) => localDay(new Date(r.ts)) === day)
}

/** Share of prompt tokens served from cache. */
export function hitRate(t: Pick<Totals, "input" | "cacheRead" | "cacheWrite">) {
  const prompt = t.input + t.cacheRead + t.cacheWrite
  return prompt > 0 ? t.cacheRead / prompt : null
}

export function compact(n: number) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B"
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K"
  return String(Math.round(n))
}

export function tps(n: number | null) {
  if (n === null) return "-"
  return n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(1)
}

/** Compact speed for the summary: thousands as K, otherwise one decimal. */
export function speed(n: number | null) {
  if (n === null) return "-"
  return n >= 1000 ? compact(n) : tps(n)
}
