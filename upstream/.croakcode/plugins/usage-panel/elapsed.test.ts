import { describe, expect, test } from "bun:test"
import { formatElapsed, turnWindow } from "./elapsed.ts"

const isGuard = (t: string) => t.startsWith("[croak-guard]")
const msgs = [
  { id: "u1", role: "user", time: { created: 1_000 } },
  { id: "a1", role: "assistant", time: { created: 1_000, completed: 103_000 } },
  { id: "u2", role: "user", time: { created: 103_000 } },
  { id: "a2", role: "assistant", time: { created: 103_000, completed: 170_000 } },
]
const parts: Record<string, { type: string; text?: string }[]> = {
  u1: [{ type: "text", text: "이미지를 분석해라" }, { type: "file" }],
  u2: [{ type: "text", text: "[croak-guard] 바로 답하라" }],
}
const partsOf = (id: string) => parts[id] ?? []

test("a guard prompt continues the user's turn", () => {
  expect(turnWindow(msgs, partsOf, isGuard, false)).toEqual({ start: 1_000, end: 170_000 })
})

test("a busy session has an open end", () => {
  expect(turnWindow(msgs, partsOf, isGuard, true)).toEqual({ start: 1_000, end: null })
})

test("a new user prompt starts a new turn", () => {
  const more = [...msgs, { id: "u3", role: "user", time: { created: 200_000 } }]
  expect(turnWindow(more, partsOf, isGuard, true)).toEqual({ start: 200_000, end: null })
  // Not answered yet and idle (for example aborted before any reply).
  expect(turnWindow(more, partsOf, isGuard, false)).toEqual({ start: 200_000, end: 200_000 })
})

test("no user message means no window", () => {
  expect(turnWindow([], partsOf, isGuard, false)).toBeUndefined()
})

test("formatElapsed", () => {
  expect(formatElapsed(0)).toBe("0:00.000s")
  expect(formatElapsed(8_213)).toBe("0:08.213s")
  expect(formatElapsed(65_400)).toBe("1:05.400s")
  expect(formatElapsed(3_725_007)).toBe("1:02:05.007s")
  expect(formatElapsed(-5)).toBe("0:00.000s")
})

import { activityLabel, openTool } from "./elapsed.ts"

const base = { busy: true, now: 10_000, streamWindowMs: 1_500 }

test("activityLabel names each phase", () => {
  expect(activityLabel({ ...base, busy: false })).toBe("완료")
  expect(activityLabel(base)).toBe("프롬프트 처리 중")
  expect(activityLabel({ ...base, lastDelta: { kind: "reasoning", at: 9_500 } })).toBe("추론 중")
  expect(activityLabel({ ...base, lastDelta: { kind: "text", at: 9_500 } })).toBe("답변 생성 중")
  // A stale chunk means the next request is being prefilled.
  expect(activityLabel({ ...base, lastDelta: { kind: "text", at: 5_000 } })).toBe("프롬프트 처리 중")
  expect(activityLabel({ ...base, openTool: { tool: "bash", status: "pending" } })).toBe("도구 호출 작성 중 · bash")
  expect(activityLabel({ ...base, openTool: { tool: "bash", status: "running" } })).toBe("도구 실행 중 · bash")
  expect(activityLabel({ ...base, openTool: { tool: "task", status: "running" } })).toBe("하위 에이전트 실행 중")
  expect(activityLabel({ ...base, waiting: "permission", openTool: { tool: "bash", status: "running" } })).toBe("권한 승인 대기")
  expect(activityLabel({ ...base, waiting: "question" })).toBe("질문 응답 대기")
  expect(activityLabel({ ...base, guard: "countdown", openTool: { tool: "bash", status: "running" } })).toBe("멈춤 · 재시작 대기")
})

test("openTool finds the latest unfinished tool", () => {
  expect(
    openTool([
      { type: "tool", tool: "read", state: { status: "completed" } },
      { type: "text" },
      { type: "tool", tool: "bash", state: { status: "running" } },
    ]),
  ).toEqual({ tool: "bash", status: "running" })
  expect(openTool([{ type: "tool", tool: "read", state: { status: "error" } }])).toBeUndefined()
})

import { breakdownItems, formatSpan, turnBreakdown } from "./elapsed.ts"

describe("turnBreakdown", () => {
  // One turn: prompt at 0, step 1 (prefill 7s, reasoning 1s, read tool 0.5s), guard prompt, step 2 (answer 2s).
  const turnMsgs = [
    { id: "u1", role: "user", time: { created: 0 } },
    { id: "a1", role: "assistant", time: { created: 0, completed: 9_000 } },
    { id: "u2", role: "user", time: { created: 9_000 } },
    { id: "a2", role: "assistant", time: { created: 9_000, completed: 12_500 } },
    { id: "u3", role: "user", time: { created: 20_000 } },
    { id: "a3", role: "assistant", time: { created: 20_000 } },
  ]
  const turnParts: Record<string, any[]> = {
    u1: [{ type: "text", text: "분석해라" }],
    a1: [
      { type: "reasoning", time: { start: 7_000, end: 8_000 } },
      { type: "tool", state: { status: "completed", time: { start: 8_200, end: 8_700 } } },
    ],
    u2: [{ type: "text", text: "[croak-guard] 이어서" }],
    a2: [{ type: "text", time: { start: 10_000, end: 12_000 } }],
    u3: [{ type: "text", text: "다음 질문" }],
    a3: [{ type: "reasoning", time: { start: 21_000 } }],
  }
  const of = (id: string) => turnParts[id] ?? []
  const prefill: Record<string, number> = { a1: 7_000, a2: 900 }

  test("splits a finished turn across a guard restart", () => {
    const b = turnBreakdown(turnMsgs, of, isGuard, (id) => prefill[id] ?? 0, { anchorID: "a2", busy: true, now: 30_000 })
    expect(b).toEqual({ total: 12_500, prefill: 7_900, reasoning: 1_000, answer: 2_000, tool: 500, other: 1_100 })
  })

  test("counts open parts up to now in the running turn", () => {
    const b = turnBreakdown(turnMsgs, of, isGuard, () => 0, { busy: true, now: 23_500 })
    // 1 s before the reasoning started was prefill; the reasoning still runs.
    expect(b).toMatchObject({ total: 3_500, reasoning: 2_500, prefill: 1_000, other: 0 })
  })

  test("counts the running prefill when nothing else runs", () => {
    const waiting = [...turnMsgs.slice(0, 5), { id: "a3", role: "assistant", time: { created: 20_000 } }]
    const b = turnBreakdown(waiting, (id) => (id === "a3" ? [] : of(id)), isGuard, () => 0, { busy: true, now: 24_000 })
    expect(b).toMatchObject({ total: 4_000, prefill: 4_000, other: 0 })
  })

  test("items skip empty parts and format milliseconds", () => {
    expect(breakdownItems({ total: 9_000, prefill: 7_012, reasoning: 0, answer: 1_988, tool: 0, other: 0 })).toEqual([
      { label: "프리필", text: "7.012s" },
      { label: "답변", text: "1.988s" },
    ])
    expect(formatSpan(61_250)).toBe("1:01.250s")
  })
})
