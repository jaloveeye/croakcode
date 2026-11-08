import { describe, expect, test } from "bun:test"
import { defaultGuardConfig, detectRepeat, expectedPrefillMs, SessionWatch } from "../../../../.croakcode/plugins/usage-panel/guard.ts"

const cfg = defaultGuardConfig

describe("detectRepeat", () => {
  test("finds a repeated block", () => {
    const block = "그러므로 다시 확인해 보면 이 값은 이전과 같고, 따라서 같은 결론에 도달한다. 다시 한 번 검토해 보자. ".repeat(3)
    expect(detectRepeat("시작 " + block.repeat(6), cfg)).toBe("repeat")
  })

  test("finds the same line repeated", () => {
    const text = "intro\n" + "| row | value | value |\n".repeat(9) + "partial"
    expect(detectRepeat(text, cfg)).toBe("line")
  })

  test("ignores ordinary varied text", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}: value ${i * 7} changes every time`).join("\n")
    expect(detectRepeat(text, cfg)).toBeUndefined()
  })

  test("ignores repeated whitespace and short lines", () => {
    expect(detectRepeat(" ".repeat(5000), cfg)).toBeUndefined()
    expect(detectRepeat("}\n".repeat(50), cfg)).toBeUndefined()
  })
})

describe("SessionWatch", () => {
  test("confirms a stall when streaming stops", () => {
    const w = new SessionWatch(cfg)
    w.setBusy(true, 0)
    w.stepStart(1_000)
    w.delta("p1", "text", "hello", 2_000)
    expect(w.check(2_000 + cfg.decodeStallMs - 1, null)).toBeUndefined()
    expect(w.check(2_000 + cfg.decodeStallMs, null)).toMatchObject({ kind: "stall", confirmed: true, reason: "decode" })
  })

  test("suspects a prefill stall only after the expected time", () => {
    const w = new SessionWatch(cfg)
    w.setBusy(true, 0)
    expect(w.check(cfg.prefillMinMs - 1, null)).toBeUndefined()
    expect(w.check(cfg.prefillMinMs, null)).toMatchObject({ kind: "stall", confirmed: false, reason: "prefill" })
    // A large context raises the limit: 3 x 100 s.
    const w2 = new SessionWatch(cfg)
    w2.setBusy(true, 0)
    expect(w2.check(200_000, 100_000)).toBeUndefined()
    expect(w2.check(300_000, 100_000)).toMatchObject({ reason: "prefill" })
  })

  test("never flags while a tool runs, and restarts the wait after it", () => {
    const w = new SessionWatch(cfg)
    w.setBusy(true, 0)
    w.stepStart(1_000)
    w.stepFinish(2_000)
    w.tool("call1", "running", 2_100)
    expect(w.check(10 * 60_000, null)).toBeUndefined()
    w.tool("call1", "completed", 10 * 60_000)
    expect(w.check(10 * 60_000 + cfg.prefillMinMs - 1, null)).toBeUndefined()
    expect(w.check(10 * 60_000 + cfg.prefillMinMs, null)).toMatchObject({ reason: "prefill" })
  })

  test("idle sessions are not checked", () => {
    const w = new SessionWatch(cfg)
    w.setBusy(true, 0)
    w.setBusy(false, 1)
    expect(w.check(10 * 60_000, null)).toBeUndefined()
  })

  test("reports a loop from streamed deltas", () => {
    const w = new SessionWatch(cfg)
    w.setBusy(true, 0)
    w.stepStart(0)
    const unit = "같은 생각을 다시 반복한다. 이 단계에서 확인할 것은 앞에서 확인한 것과 같다. 그러니 다시 처음부터 확인한다. "
    let verdict
    for (let i = 0; i < 40 && !verdict; i++) verdict = w.delta("r1", "reasoning", unit, i)
    expect(verdict).toMatchObject({ kind: "loop", reason: "repeat", partKind: "reasoning" })
  })

  test("reports a runaway part by length", () => {
    const w = new SessionWatch({ ...cfg, maxPartChars: 1_000 })
    w.setBusy(true, 0)
    let verdict
    for (let i = 0; i < 200 && !verdict; i++) verdict = w.delta("t1", "text", `token${i} `, i)
    expect(verdict).toMatchObject({ kind: "loop", reason: "length" })
  })
})

test("expectedPrefillMs", () => {
  expect(expectedPrefillMs(60_000, 1_000)).toBe(60_000)
  expect(expectedPrefillMs(null, 1_000)).toBeNull()
  expect(expectedPrefillMs(60_000, null)).toBeNull()
})

describe("overthinking", () => {
  test("reasoning without answer text stops at the character budget", () => {
    const w = new SessionWatch({ ...cfg, maxReasoningChars: 1_000 })
    w.setBusy(true, 0)
    w.stepStart(0)
    let verdict
    for (let i = 0; i < 100 && !verdict; i++) verdict = w.delta("r1", "reasoning", `생각 ${i}번째 줄은 내용이 매번 다르다.\n`, i)
    expect(verdict).toMatchObject({ kind: "loop", reason: "overthink", partKind: "reasoning" })
  })

  test("reasoning after the answer started is not limited", () => {
    const w = new SessionWatch({ ...cfg, maxReasoningChars: 1_000 })
    w.setBusy(true, 0)
    w.stepStart(0)
    w.delta("t1", "text", "답변을 시작한다.", 0)
    let verdict
    for (let i = 0; i < 100 && !verdict; i++) verdict = w.delta("r1", "reasoning", `생각 ${i}번째 줄은 내용이 매번 다르다.\n`, i)
    expect(verdict).toBeUndefined()
  })

  test("reasoning without answer text stops at the time budget", () => {
    const w = new SessionWatch({ ...cfg, maxReasoningMs: 1_000 })
    w.setBusy(true, 0)
    w.stepStart(0)
    w.delta("r1", "reasoning", "생각", 100)
    w.delta("r1", "reasoning", "계속", 900)
    expect(w.check(1_050, null)).toBeUndefined()
    expect(w.check(1_100, null)).toMatchObject({ reason: "overthink" })
    // Reported once per step.
    expect(w.check(1_200, null)).toBeUndefined()
  })

  test("a new step resets the budget", () => {
    const w = new SessionWatch({ ...cfg, maxReasoningChars: 100 })
    w.setBusy(true, 0)
    w.stepStart(0)
    w.delta("r1", "reasoning", "가".repeat(80), 0)
    w.stepFinish(1)
    w.stepStart(2)
    expect(w.delta("r2", "reasoning", "나".repeat(80), 3)).toBeUndefined()
  })
})

describe("waiting is not a stall", () => {
  test("a tool that runs while the step is streaming is not a stall", () => {
    // The bug of 2026-11-06: bash waited for permission inside the step and was aborted.
    const w = new SessionWatch(cfg)
    w.setBusy(true, 0)
    w.stepStart(0)
    w.delta("r1", "reasoning", "bash로 확인한다", 1_000)
    w.tool("call1", "running", 2_000)
    expect(w.check(10 * 60_000, null)).toBeUndefined()
  })

  test("a pause holds every clock and restarts them on resume", () => {
    const w = new SessionWatch(cfg)
    w.setBusy(true, 0)
    w.stepStart(0)
    w.delta("r1", "reasoning", "생각", 1_000)
    w.setPaused(true, 2_000)
    expect(w.check(10 * 60_000, null)).toBeUndefined()
    w.setPaused(false, 10 * 60_000)
    expect(w.check(10 * 60_000 + cfg.decodeStallMs - 1, null)).toBeUndefined()
    expect(w.check(10 * 60_000 + cfg.decodeStallMs, null)).toMatchObject({ kind: "stall", confirmed: true })
  })
})
