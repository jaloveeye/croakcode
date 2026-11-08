// Detects stalled and runaway generations for one session. Pure state machine:
// the caller feeds events and timestamps and acts on the verdicts.

export type GuardConfig = {
  /** No streamed data for this long after tokens started: a confirmed stall. */
  decodeStallMs: number
  /** Waiting for the first token never counts as a stall before this. */
  prefillMinMs: number
  /** Suspect a prefill stall after this many times the expected prefill time. */
  prefillFactor: number
  /** Repetition check: the last `loopNeedle` characters ... */
  loopNeedle: number
  /** ... appear this many times within the last `loopWindow` characters. */
  loopRepeats: number
  loopWindow: number
  /** The same non-empty line repeated this many times in a row. */
  lineRepeats: number
  /** One reasoning or text part longer than this is treated as runaway. */
  maxPartChars: number
  /** Reasoning without any answer text in one step: stop after this many characters ... */
  maxReasoningChars: number
  /** ... or after this long. */
  maxReasoningMs: number
}

export const defaultGuardConfig: GuardConfig = {
  decodeStallMs: 60_000,
  prefillMinMs: 120_000,
  prefillFactor: 3,
  loopNeedle: 120,
  loopRepeats: 5,
  loopWindow: 6_000,
  lineRepeats: 8,
  maxPartChars: 120_000,
  // About 6,500 tokens; the 16,384-token output limit was hit at 60,794 characters.
  maxReasoningChars: 24_000,
  maxReasoningMs: 180_000,
}

export type Verdict =
  | { kind: "stall"; confirmed: true; reason: "decode"; idleMs: number }
  | { kind: "stall"; confirmed: false; reason: "prefill"; idleMs: number }
  | { kind: "loop"; reason: "repeat" | "line" | "length" | "overthink"; partKind: PartKind }

export type PartKind = "text" | "reasoning"

/** True when the tail of `text` repeats: an exact block or the same line over and over. */
export function detectRepeat(text: string, cfg: Pick<GuardConfig, "loopNeedle" | "loopRepeats" | "loopWindow" | "lineRepeats">) {
  const window = text.slice(-cfg.loopWindow)
  const needle = window.slice(-cfg.loopNeedle)
  if (needle.length === cfg.loopNeedle && needle.trim().length >= 20) {
    let count = 0
    let at = window.indexOf(needle)
    while (at !== -1) {
      count++
      if (count >= cfg.loopRepeats) return "repeat" as const
      at = window.indexOf(needle, at + needle.length)
    }
  }
  const lines = window.split("\n")
  // Ignore the line still being written.
  lines.pop()
  const last = lines.at(-1)?.trim()
  if (last && last.length >= 10) {
    let run = 0
    for (let i = lines.length - 1; i >= 0 && lines[i].trim() === last; i--) run++
    if (run >= cfg.lineRepeats) return "line" as const
  }
  return undefined
}

export class SessionWatch {
  private busy = false
  /** Waiting on the user (permission or question); nothing is expected from the model. */
  private paused = false
  private streaming = false
  private waitingSince = 0
  private lastActivity = 0
  private tools = new Set<string>()
  /** Tail of each streaming part, its total length, and the length at the last repeat check. */
  /** Current step: reasoning before any answer text. */
  private stepReasoningChars = 0
  private stepReasoningSince = 0
  private stepText = false
  private stepReported = false
  private buffers = new Map<string, { kind: PartKind; text: string; length: number; checkedAt: number }>()

  constructor(private cfg: GuardConfig = defaultGuardConfig) {}

  get isBusy() {
    return this.busy
  }

  setBusy(busy: boolean, now: number) {
    if (busy && !this.busy) {
      this.waitingSince = now
      this.lastActivity = now
    }
    if (!busy) {
      this.streaming = false
      this.tools.clear()
      this.buffers.clear()
    }
    this.busy = busy
  }

  private resetStep() {
    this.stepReasoningChars = 0
    this.stepReasoningSince = 0
    this.stepText = false
    this.stepReported = false
  }

  stepStart(now: number) {
    this.streaming = true
    this.lastActivity = now
    this.resetStep()
  }

  stepFinish(now: number) {
    this.streaming = false
    this.resetStep()
    this.buffers.clear()
    this.waitingSince = now
    this.lastActivity = now
  }

  /** Pause while the user must act. On resume the stall clocks start over. */
  setPaused(paused: boolean, now: number) {
    if (this.paused && !paused) {
      this.lastActivity = now
      this.waitingSince = now
      if (this.stepReasoningSince) this.stepReasoningSince = now
    }
    this.paused = paused
  }

  /** Tool part state change; a step waits on the model again once no tool runs. */
  tool(callID: string, status: string, now: number) {
    this.lastActivity = now
    if (status === "pending" || status === "running") this.tools.add(callID)
    else {
      this.tools.delete(callID)
      if (this.tools.size === 0) this.waitingSince = now
    }
  }

  /** Any streamed data. Returns a loop verdict when the part runs away. */
  delta(partID: string, kind: PartKind, chunk: string, now: number): Verdict | undefined {
    this.lastActivity = now
    this.streaming = true
    const buf = this.buffers.get(partID) ?? { kind, text: "", length: 0, checkedAt: 0 }
    buf.text += chunk
    buf.length += chunk.length
    if (buf.text.length > this.cfg.loopWindow * 2) buf.text = buf.text.slice(-this.cfg.loopWindow)
    this.buffers.set(partID, buf)
    if (kind === "text" && chunk.trim()) this.stepText = true
    if (kind === "reasoning" && !this.stepText) {
      if (!this.stepReasoningSince) this.stepReasoningSince = now
      this.stepReasoningChars += chunk.length
      if (!this.stepReported && this.stepReasoningChars > this.cfg.maxReasoningChars) {
        this.stepReported = true
        return { kind: "loop", reason: "overthink", partKind: "reasoning" }
      }
    }
    if (buf.length > this.cfg.maxPartChars) return { kind: "loop", reason: "length", partKind: kind }
    // Checking every ~200 characters keeps the cost low.
    if (buf.length - buf.checkedAt < 200) return undefined
    buf.checkedAt = buf.length
    const found = detectRepeat(buf.text, this.cfg)
    return found ? { kind: "loop", reason: found, partKind: kind } : undefined
  }

  /** Periodic check. `expectedPrefillMs` estimates a cold prefill of the current context. */
  check(now: number, expectedPrefillMs: number | null): Verdict | undefined {
    if (!this.busy) return undefined
    // A running tool or a pending permission produces no tokens; neither is a stall.
    if (this.paused || this.tools.size > 0) return undefined
    if (this.streaming) {
      if (
        !this.stepText &&
        !this.stepReported &&
        this.stepReasoningSince &&
        now - this.stepReasoningSince >= this.cfg.maxReasoningMs
      ) {
        this.stepReported = true
        return { kind: "loop", reason: "overthink", partKind: "reasoning" }
      }
      const idle = now - this.lastActivity
      if (idle >= this.cfg.decodeStallMs) return { kind: "stall", confirmed: true, reason: "decode", idleMs: idle }
      return undefined
    }
    const waited = now - this.waitingSince
    const limit = Math.max(this.cfg.prefillMinMs, this.cfg.prefillFactor * (expectedPrefillMs ?? 0))
    if (waited >= limit) return { kind: "stall", confirmed: false, reason: "prefill", idleMs: waited }
    return undefined
  }
}

/** Cold prefill estimate for a context of `contextTokens` at `prefillTps`. */
export function expectedPrefillMs(contextTokens: number | null, prefillTps: number | null) {
  if (!contextTokens || !prefillTps || prefillTps <= 0) return null
  return (contextTokens / prefillTps) * 1000
}
