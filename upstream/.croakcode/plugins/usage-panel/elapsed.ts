// Elapsed time of the current turn: from the user's last prompt to the end of
// the answer. Prompts the guard sent on the user's behalf do not start a turn.

type Msg = { id: string; role: string; time: { created: number; completed?: number } }
type Part = { type: string; text?: string }

export type TurnWindow = { start: number; end: number | null }

export function turnWindow(
  messages: readonly Msg[],
  partsOf: (messageID: string) => readonly Part[],
  isGuardText: (text: string) => boolean,
  busy: boolean,
): TurnWindow | undefined {
  let i = messages.length - 1
  for (; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "user") continue
    const guard = partsOf(m.id).some((p) => p.type === "text" && p.text !== undefined && isGuardText(p.text))
    if (!guard) break
  }
  if (i < 0) return undefined
  const start = messages[i].time.created
  if (busy) return { start, end: null }
  let end: number | null = null
  for (let j = messages.length - 1; j > i; j--) {
    if (messages[j].role === "assistant") {
      end = messages[j].time.completed ?? null
      break
    }
  }
  return { start, end: end ?? start }
}

/** `m:ss.mmm` with an explicit `s` unit, or `h:mm:ss.mmm` from one hour. */
export function formatElapsed(ms: number) {
  const totalMs = Math.max(0, Math.floor(ms))
  const total = Math.floor(totalMs / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = `${String(s).padStart(2, "0")}.${String(totalMs % 1000).padStart(3, "0")}`
  return `${h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`}s`
}

export type ActivityInput = {
  busy: boolean
  guard?: "countdown" | "loop" | "ask"
  /** The session waits for the user to answer a permission request or a question. */
  waiting?: "permission" | "question"
  /** Kind and time of the last streamed chunk. */
  lastDelta?: { kind: "reasoning" | "text"; at: number }
  /** Latest tool part of the current answer that has not finished. */
  openTool?: { tool: string; status: string }
  now: number
  streamWindowMs: number
}

/** One short Korean label for what the session is doing right now. */
export function activityLabel(a: ActivityInput) {
  if (!a.busy) return "완료"
  if (a.guard === "countdown") return "멈춤 · 재시작 대기"
  if (a.guard === "loop") return "반복 감지"
  if (a.guard === "ask") return "확인 필요"
  if (a.waiting === "permission") return "권한 승인 대기"
  if (a.waiting === "question") return "질문 응답 대기"
  if (a.openTool) {
    if (a.openTool.tool === "task" && a.openTool.status === "running") return "하위 에이전트 실행 중"
    if (a.openTool.status === "pending") return `도구 호출 작성 중 · ${a.openTool.tool}`
    return `도구 실행 중 · ${a.openTool.tool}`
  }
  if (a.lastDelta && a.now - a.lastDelta.at < a.streamWindowMs) {
    return a.lastDelta.kind === "reasoning" ? "추론 중" : "답변 생성 중"
  }
  return "프롬프트 처리 중"
}

/** The last unfinished tool part among `parts`. */
export function openTool(parts: readonly { type: string; tool?: string; state?: { status?: string } }[]) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (p.type !== "tool" || !p.tool) continue
    const status = p.state?.status
    if (status === "pending" || status === "running") return { tool: p.tool, status }
  }
  return undefined
}

type TimedPart = {
  type: string
  time?: { start?: number; end?: number }
  state?: { status?: string; time?: { start?: number; end?: number } }
}

export type Breakdown = {
  total: number
  prefill: number
  reasoning: number
  answer: number
  tool: number
  other: number
}

/**
 * Time split of the turn that contains `anchorID` (an assistant message), or of
 * the latest turn. `prefillOf` returns the summed first-token wait of a message's
 * finished steps; unfinished parts count up to `now`.
 */
export function turnBreakdown(
  messages: readonly Msg[],
  partsOf: (messageID: string) => readonly (Part & TimedPart)[],
  isGuardText: (text: string) => boolean,
  prefillOf: (messageID: string) => number,
  opts: { anchorID?: string; busy: boolean; now: number },
): Breakdown | undefined {
  const isRealUser = (m: Msg) =>
    m.role === "user" && !partsOf(m.id).some((p) => p.type === "text" && p.text !== undefined && isGuardText(p.text))
  let anchor = opts.anchorID ? messages.findIndex((m) => m.id === opts.anchorID) : messages.length - 1
  if (anchor < 0) return undefined
  let first = anchor
  while (first >= 0 && !isRealUser(messages[first])) first--
  if (first < 0) return undefined
  let last = first + 1
  while (last < messages.length && !isRealUser(messages[last])) last++
  const turn = messages.slice(first, last)
  const open = opts.busy && last === messages.length

  const span = (t?: { start?: number; end?: number }) =>
    t?.start ? Math.max(0, (t.end ?? (open ? opts.now : t.start)) - t.start) : 0
  const b: Breakdown = { total: 0, prefill: 0, reasoning: 0, answer: 0, tool: 0, other: 0 }
  let end = turn[0].time.created
  const lastAssistant = turn.findLast((m) => m.role === "assistant")
  for (const m of turn) {
    if (m.role !== "assistant") continue
    if (m.time.completed) end = Math.max(end, m.time.completed)
    const parts = partsOf(m.id)
    for (const p of parts) {
      if (p.type === "reasoning") b.reasoning += span(p.time)
      else if (p.type === "text") b.answer += span(p.time)
      else if (p.type === "tool") b.tool += span(p.state?.time)
    }
    // A running message has not logged its steps' prefill yet; use the gaps
    // where nothing ran instead. Finished messages use the log.
    b.prefill += open && m === lastAssistant ? idleGaps(m.time.created, parts, opts.now) : prefillOf(m.id)
  }
  b.total = (open ? opts.now : end) - turn[0].time.created
  b.other = Math.max(0, b.total - b.prefill - b.reasoning - b.answer - b.tool)
  return b
}

/** Time inside [from, now] when no part was running: the waits for each step's first token. */
export function idleGaps(from: number, parts: readonly TimedPart[], now: number) {
  const spans = parts
    .map((p) => (p.type === "tool" ? p.state?.time : p.time))
    .filter((t): t is { start: number; end?: number } => Boolean(t?.start))
    .sort((a, b) => a.start - b.start)
  let cursor = from
  let idle = 0
  for (const t of spans) {
    if (t.start > cursor) idle += t.start - cursor
    cursor = Math.max(cursor, t.end ?? now)
  }
  return idle + Math.max(0, now - cursor)
}

/** `7.012s` under a minute, otherwise `m:ss.mmm`. */
export function formatSpan(ms: number) {
  return ms < 60_000 ? `${(Math.max(0, ms) / 1000).toFixed(3)}s` : formatElapsed(ms)
}

/** Non-zero parts of a breakdown as label and formatted time, in a fixed order. */
export function breakdownItems(b: Breakdown) {
  const items: [string, number][] = [
    ["프리필", b.prefill],
    ["추론", b.reasoning],
    ["답변", b.answer],
    ["도구", b.tool],
    ["기타", b.other],
  ]
  return items.filter(([, ms]) => ms >= 1).map(([label, ms]) => ({ label, text: formatSpan(ms) }))
}
