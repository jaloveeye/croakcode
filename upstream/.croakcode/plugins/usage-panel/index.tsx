/** @jsxImportSource @opentui/solid */
// Sidebar panel: session and daily token usage, prefill/decode speed, and an
// animated avatar. Speeds come from the JSONL that usage-meter.mjs writes.
import { createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createActivity, STREAM_WINDOW_MS } from "./activity.ts"
import { Avatar } from "./avatar.tsx"
import { createGuard, GUARD_MARK, type Guard, type GuardOptions } from "./controller.tsx"
import { breakdownItems, formatSpan, turnBreakdown } from "./elapsed.ts"
import { expectedPrefillMs } from "./guard.ts"
import { activeNotice, makeNotice, type Notice } from "./notice.ts"
import { loadSprite, type AnimationName, type Sprite } from "./sprite.ts"
import {
  appendCapped,
  compact,
  createLogReader,
  hitRate,
  localDay,
  onDay,
  speed,
  speeds,
  totals,
  type UsageRecord,
} from "./usage-log.ts"

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** `avatarScale` shrinks the avatar picture; 1 keeps the sprite's own size. */
type Options = { sprite?: string; avatar?: boolean; avatarScale?: number; guard?: false | GuardOptions }

const DEFAULT_AVATAR_SCALE = 0.9

function resolveSprite(spec: string | undefined): Sprite | undefined {
  const name = spec || process.env.CROAK_AVATAR || "treefrog"
  const file = name.endsWith(".json") ? path.resolve(name) : path.join(HERE, "sprites", `${name}.json`)
  try {
    return loadSprite(file)
  } catch (error) {
    console.error("usage-panel: sprite load failed:", error)
    return undefined
  }
}

// Shared across sidebar instances: one reader, one record list.
const reader = createLogReader()
const [records, setRecords] = createSignal<UsageRecord[]>([])
const refresh = () => {
  const more = reader.poll()
  if (more.length) setRecords((list) => appendCapped(list, more))
}

/** Sidebar content width (42 - panel padding). Used to right-align metric rows. */
const SUMMARY_GAUGE = 37

const summaryRule = (prefix: string) => "─".repeat(Math.max(1, SUMMARY_GAUGE - Bun.stringWidth(prefix)))

/** A foldable subsection of the summary, mirroring cache-hit's section header. */
function SummarySection(props: { title: string; muted: () => string; text: () => string; children: JSX.Element }) {
  const [open, setOpen] = createSignal(true)
  const prefix = () => `${open() ? "▼ " : "▶ "}${props.title} `
  return (
    <>
      <text onMouseUp={() => setOpen((value) => !value)}>
        <span style={{ fg: props.muted() }}>{open() ? "▼ " : "▶ "}</span>
        <span style={{ fg: props.text() }}>
          <b>{props.title}</b>
        </span>
        <span style={{ fg: props.muted() }}> {summaryRule(prefix())}</span>
      </text>
      <Show when={open()}>{props.children}</Show>
    </>
  )
}

/** One label/value line, value right-aligned within the sidebar gauge. */
function SummaryRow(props: { label: string; value: string; unit?: string; fg: () => string }) {
  const line = () => {
    const unit = props.unit ? ` ${props.unit}` : ""
    const used = Bun.stringWidth(props.label) + Bun.stringWidth(props.value) + Bun.stringWidth(unit)
    return props.label + " ".repeat(Math.max(1, SUMMARY_GAUGE - used)) + props.value + unit
  }
  return <text fg={props.fg()}>{line()}</text>
}

/** A speech bubble above the avatar with the current turn's status and times. */
function SpeechBubble(props: {
  elapsed: () => string | null
  label: () => string
  items: () => { label: string; text: string }[]
  /** Formatted total of the turn; falls back to the elapsed clock. */
  total: () => string | undefined
  border: () => string
  fg: () => string
  /** A block notice; shown on top, and the bubble shows even without a turn. */
  notice?: () => string | undefined
  noticeFg?: () => string
}) {
  return (
    <Show when={props.notice?.() || props.elapsed()}>
      <box alignItems="center">
        <box width={24} border borderStyle="rounded" borderColor={props.border()} paddingLeft={1} paddingRight={1}>
          <Show when={props.notice?.()}>
            {(text) => (
              <text fg={props.noticeFg?.() ?? props.fg()} wrapMode="word">
                <b>{text()}</b>
              </text>
            )}
          </Show>
          <Show when={props.elapsed()}>
            {(elapsed) => (
              <>
                <text fg={props.fg()} wrapMode="word">
                  {props.label()}
                </text>
                <text fg={props.fg()}>전체 {props.total() ?? elapsed()}</text>
                <For each={props.items()}>
                  {(item) => (
                    <text fg={props.fg()}>
                      {item.label} {item.text}
                    </text>
                  )}
                </For>
              </>
            )}
          </Show>
        </box>
        <text fg={props.border()}>▼</text>
      </box>
    </Show>
  )
}

/** Approval mode next to the avatar. Toggle with /permissions. */
function ApprovalBadge(props: { mode: () => string; theme: () => any }) {
  const auto = () => props.mode() === "auto"
  const color = () => (auto() ? props.theme().warning : props.theme().textMuted)
  return (
    <box border borderStyle="rounded" borderColor={color()} paddingLeft={1} paddingRight={1}>
      <text fg={auto() ? props.theme().warning : props.theme().text}>
        <b>{auto() ? "⚡ 자동 승인" : "✋ 수동 승인"}</b>
      </text>
    </box>
  )
}

function View(props: { api: any; sessionID: string; sprite?: Sprite; scale?: number; guard?: Guard }) {
  const api = props.api
  const theme = () => api.theme.current
  const activity = createActivity(api, props.sessionID, props.guard)
  const bubbleBreakdown = createMemo(() =>
    breakdownFor(api, props.sessionID, { busy: activity.busy(), now: activity.now() }),
  )
  const bubbleItems = () => {
    const b = bubbleBreakdown()
    return b ? breakdownItems(b) : []
  }
  const bubbleTotal = () => {
    const b = bubbleBreakdown()
    return b ? formatSpan(b.total) : undefined
  }
  const [children, setChildren] = createSignal<string[]>([])
  const [lastDelta, setLastDelta] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())
  // Folded by default: the title row carries the today totals, like cache-hit.
  const [summaryOpen, setSummaryOpen] = createSignal(false)

  const loadChildren = async () => {
    try {
      const res = await api.client.session.children({ sessionID: props.sessionID })
      const list = Array.isArray(res?.data) ? res.data : []
      setChildren(list.map((s: { id: string }) => s.id))
    } catch {
      // Child sessions are optional detail.
    }
  }
  void loadChildren()

  const ids = createMemo(() => new Set([props.sessionID, ...children()]))

  // Blocks by the plugins or the gate, shown on the avatar until the first of:
  // 20 seconds, a new prompt, a click on the avatar.
  const [notice, setNotice] = createSignal<Notice>()
  const [lastPromptAt, setLastPromptAt] = createSignal(0)
  const shownNotice = () => activeNotice(notice(), now(), lastPromptAt())
  const raise = (message: unknown) => {
    const n = makeNotice(message, Date.now())
    if (n) setNotice(n)
  }
  /** A permission or question dialog is open in this session or a child. */
  const waitingOnUser = () =>
    [...ids()].some(
      (id) => (api.state.session.permission?.(id) ?? []).length > 0 || (api.state.session.question?.(id) ?? []).length > 0,
    )

  const offs = [
    api.event.on("message.part.delta", (e: any) => {
      if (ids().has(e.properties.sessionID)) setLastDelta(Date.now())
    }),
    api.event.on("message.part.updated", (e: any) => {
      const part = e.properties.part
      if (part?.type === "step-finish") setTimeout(refresh, 300)
      if (part?.type === "text" || part?.type === "reasoning") {
        if (ids().has(part.sessionID)) setLastDelta(Date.now())
      }
    }),
    api.event.on("session.created", (e: any) => {
      if (e.properties.info?.parentID === props.sessionID) void loadChildren()
    }),
    api.event.on("message.part.updated", (e: any) => {
      const part = e.properties.part
      if (part?.type === "tool" && part.state?.status === "error" && ids().has(part.sessionID)) raise(part.state.error)
    }),
    api.event.on("session.error", (e: any) => {
      const id = e.properties?.sessionID
      if (!id || ids().has(id)) raise(e.properties?.error)
    }),
    api.event.on("message.updated", (e: any) => {
      const info = e.properties?.info
      if (info?.role === "user" && info.sessionID === props.sessionID && info.time?.created) {
        setLastPromptAt(Math.max(lastPromptAt(), info.time.created))
      }
    }),
  ]
  const clock = setInterval(() => setNow(Date.now()), 250)
  onCleanup(() => {
    offs.forEach((off: () => void) => off())
    clearInterval(clock)
  })

  // Main session tokens come from opencode's own messages, so history before
  // the meter was installed still counts. Child sessions come from the log.
  const sessionTotals = createMemo(() => {
    const own = api.state.session
      .messages(props.sessionID)
      .filter((m: any) => m.role === "assistant" && m.tokens)
      .map((m: any) => ({
        tokens: {
          input: m.tokens.input,
          output: m.tokens.output,
          reasoning: m.tokens.reasoning,
          cacheRead: m.tokens.cache.read,
          cacheWrite: m.tokens.cache.write,
        },
      }))
    const kids = records().filter((r) => r.sessionID !== props.sessionID && ids().has(r.sessionID))
    return totals([...own, ...kids])
  })
  const sessionSpeeds = createMemo(() => speeds(records().filter((r) => ids().has(r.sessionID))))
  const today = createMemo(() => totals(onDay(records(), localDay(new Date(now())))))

  const guardState = () => props.guard?.states()[props.sessionID]
  const phase = (): AnimationName => {
    const g = guardState()
    if (g?.kind === "countdown") return "sleep"
    if (g?.kind === "loop") return "dizzy"
    if (g?.kind === "ask") return "ask"
    if (shownNotice()) return "alert"
    if (waitingOnUser()) return "ask"
    const busy = [...ids()].some((id) => {
      const type = api.state.session.status(id)?.type
      return type === "busy" || type === "retry"
    })
    if (!busy) return "idle"
    return now() - lastDelta() < STREAM_WINDOW_MS ? "run" : "think"
  }

  const muted = () => theme().textMuted
  const approvalMode = () => api.permission?.mode?.() ?? "ask"
  const hit = () => {
    const rate = hitRate(sessionTotals())
    return rate === null ? "-" : `${Math.round(rate * 100)}%`
  }
  const todayTokens = () => {
    const t = today()
    return t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite
  }
  const todayLine = () => `today ${compact(todayTokens())} tok · ${today().requests} req`

  return (
    <box>
      <text fg={theme().text}>
        <b>Usage</b>
      </text>
      <Show when={props.sprite}>
        {(sprite) => (
          <box width="100%" alignItems="center">
            <SpeechBubble
              elapsed={activity.elapsed}
              label={activity.label}
              items={bubbleItems}
              total={bubbleTotal}
              border={() => {
                if (shownNotice()) return theme().error
                if (guardState() || waitingOnUser()) return theme().warning
                return activity.busy() ? theme().accent : theme().border
              }}
              fg={() => (activity.busy() ? theme().text : theme().textMuted)}
              notice={() => shownNotice()?.text}
              noticeFg={() => theme().error}
            />
            <Avatar
              sprite={sprite()}
              animation={phase}
              decodeTps={() => sessionSpeeds().lastDecode}
              onClick={() => {
                // A click first dismisses a block notice, then acts as the guard's button.
                if (shownNotice()) setNotice(undefined)
                else props.guard?.click(props.sessionID)
              }}
              mode={approvalMode}
              scale={props.scale}
            />
            <Show when={api.permission}>
              <ApprovalBadge mode={approvalMode} theme={theme} />
            </Show>
          </box>
        )}
      </Show>
      <Show when={guardState()}>
        {(g) => (
          <text fg={theme().warning}>
            {g().kind === "countdown"
              ? `멈춤 · ${Math.max(0, Math.ceil(((g() as { until: number }).until - now()) / 1000))}초 뒤 재시작 (클릭: 취소)`
              : g().kind === "loop"
                ? "반복 감지 · 이어서 진행"
                : "응답 지연 · 클릭해서 선택"}
          </text>
        )}
      </Show>
      <text onMouseUp={() => setSummaryOpen((open) => !open)}>
        <span style={{ fg: muted() }}>{summaryOpen() ? "▼ " : "▶ "}</span>
        <span style={{ fg: theme().text }}>
          <b>요약</b>
        </span>
        <Show when={!summaryOpen()}>
          <span style={{ fg: muted() }}>
            {"  "}
            {todayLine()}
          </span>
        </Show>
      </text>
      <Show when={summaryOpen()}>
        <SummarySection title="토큰" muted={muted} text={() => theme().text}>
          <SummaryRow label="in" value={compact(sessionTotals().input)} unit="tok" fg={muted} />
          <SummaryRow
            label="out"
            value={compact(sessionTotals().output + sessionTotals().reasoning)}
            unit="tok"
            fg={muted}
          />
          <SummaryRow label="cache" value={compact(sessionTotals().cacheRead)} unit="tok" fg={muted} />
          <SummaryRow label="hit" value={hit()} fg={muted} />
        </SummarySection>
        <SummarySection title="속도" muted={muted} text={() => theme().text}>
          <SummaryRow label="prefill" value={speed(sessionSpeeds().lastPrefill)} unit="t/s" fg={muted} />
          <SummaryRow label="prefill avg" value={speed(sessionSpeeds().avgPrefill)} unit="t/s" fg={muted} />
          <SummaryRow label="prefill min" value={speed(sessionSpeeds().minPrefill)} unit="t/s" fg={muted} />
          <SummaryRow label="prefill max" value={speed(sessionSpeeds().maxPrefill)} unit="t/s" fg={muted} />
          <SummaryRow label="decode" value={speed(sessionSpeeds().lastDecode)} unit="t/s" fg={muted} />
          <SummaryRow label="decode avg" value={speed(sessionSpeeds().avgDecode)} unit="t/s" fg={muted} />
          <SummaryRow label="decode min" value={speed(sessionSpeeds().minDecode)} unit="t/s" fg={muted} />
          <SummaryRow label="decode max" value={speed(sessionSpeeds().maxDecode)} unit="t/s" fg={muted} />
          <SummaryRow
            label="ttft"
            value={
              sessionSpeeds().lastTtftMs === null ? "-" : `${((sessionSpeeds().lastTtftMs ?? 0) / 1000).toFixed(1)}s`
            }
            fg={muted}
          />
        </SummarySection>
        <SummarySection title="오늘" muted={muted} text={() => theme().text}>
          <SummaryRow label="tokens" value={compact(todayTokens())} unit="tok" fg={muted} />
          <SummaryRow label="requests" value={String(today().requests)} fg={muted} />
        </SummarySection>
      </Show>
    </box>
  )
}

/** Live elapsed time of the current turn, shown right of the agent and model under the prompt. */
function PromptTimer(props: { api: any; sessionID: string; guard?: Guard }) {
  const api = props.api
  const theme = () => api.theme.current
  const activity = createActivity(api, props.sessionID, props.guard)

  return (
    <Show when={activity.turn()}>
      <text fg={activity.busy() ? theme().text : theme().textMuted}>
        ⏱ {activity.elapsed() ?? "0:00.000s"} · {activity.label()}
      </text>
    </Show>
  )
}

/** Cold prefill estimate for the session's current context from logged speeds. */
function expectedFor(sessionID: string) {
  const all = records()
  const own = all.filter((r) => r.sessionID === sessionID)
  const last = own.at(-1)
  if (!last) return null
  const context = last.tokens.input + last.tokens.cacheRead + last.tokens.cacheWrite
  return expectedPrefillMs(context, speeds(own).avgPrefill ?? speeds(all).avgPrefill)
}

/** Summed first-token wait of each message's finished steps, rebuilt when the log grows. */
let prefillCache: { list: UsageRecord[]; byMessage: Map<string, number> } | undefined
function prefillOf(messageID: string) {
  const list = records()
  if (prefillCache?.list !== list) {
    const byMessage = new Map<string, number>()
    for (const r of list) if (r.ttftMs) byMessage.set(r.messageID, (byMessage.get(r.messageID) ?? 0) + r.ttftMs)
    prefillCache = { list, byMessage }
  }
  return prefillCache.byMessage.get(messageID) ?? 0
}

function breakdownFor(api: any, sessionID: string, opts: { anchorID?: string; busy: boolean; now: number }) {
  return turnBreakdown(
    api.state.session.messages(sessionID),
    (id: string) => api.state.part(id),
    (text: string) => text.startsWith(GUARD_MARK),
    prefillOf,
    opts,
  )
}

/** Time split of the turn under its final answer: total, prefill, reasoning, answer, tools. */
function MessageFooter(props: { api: any; sessionID: string; messageID: string }) {
  const api = props.api
  const theme = () => api.theme.current
  const busy = () => {
    const type = api.state.session.status(props.sessionID)?.type
    return type === "busy" || type === "retry"
  }
  const [now, setNow] = createSignal(Date.now())
  let timer: ReturnType<typeof setTimeout>
  const tick = () => {
    setNow(Date.now())
    timer = setTimeout(tick, busy() ? 100 : 1000)
  }
  timer = setTimeout(tick, 0)
  onCleanup(() => clearTimeout(timer))

  // Only the last assistant message of a turn gets the line; earlier steps and
  // guard-interrupted messages would repeat the same numbers.
  const isTurnEnd = createMemo(() => {
    const msgs = api.state.session.messages(props.sessionID)
    const i = msgs.findIndex((m: any) => m.id === props.messageID)
    if (i < 0) return false
    const next = msgs[i + 1]
    if (!next) return true
    if (next.role !== "user") return false
    const parts = api.state.part(next.id)
    return !parts.some((p: any) => p.type === "text" && p.text?.startsWith(GUARD_MARK))
  })
  // Keep each "label value" chunk intact and wrap at chunk boundaries, so a
  // narrow transcript never breaks a duration or strands a middle dot.
  const chunks = createMemo(() => {
    if (!isTurnEnd()) return []
    const b = breakdownFor(api, props.sessionID, { anchorID: props.messageID, busy: busy(), now: now() })
    if (!b) return []
    return [`전체 ${formatSpan(b.total)}`, ...breakdownItems(b).map((i) => `${i.label} ${i.text}`)]
  })

  return (
    <Show when={chunks().length}>
      <box flexDirection="row" flexWrap="wrap" gap={2} paddingLeft={2}>
        <For each={chunks()}>
          {(chunk) => (
            <text fg={theme().textMuted} wrapMode="none">
              {chunk}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

const tui = async (api: any, options: Options | undefined) => {
  refresh()
  const sprite = options?.avatar === false ? undefined : resolveSprite(options?.sprite)
  const scale = options?.avatarScale ?? DEFAULT_AVATAR_SCALE
  const guard = options?.guard === false ? undefined : createGuard(api, options?.guard ?? {}, expectedFor)
  if (guard) api.lifecycle?.onDispose?.(() => guard.dispose())
  // TuiSlotPlugin slots receive (ctx, props) in the plugin's own API shape. The host
  // slot map (TuiHostSlotMap in @croakcode/plugin/tui) defines session_id /
  // message_id for session_message_footer and session_id for the other two, which
  // is exactly what is destructured here.
  api.slots.register({
    order: 90,
    slots: {
      session_message_footer(_ctx: unknown, props: { session_id: string; message_id: string }) {
        return <MessageFooter api={api} sessionID={props.session_id} messageID={props.message_id} />
      },
      session_prompt_right(_ctx: unknown, props: { session_id: string }) {
        return <PromptTimer api={api} sessionID={props.session_id} guard={guard} />
      },
      sidebar_content(_ctx: unknown, props: { session_id: string }) {
        return <View api={api} sessionID={props.session_id} sprite={sprite} scale={scale} guard={guard} />
      },
    },
  })
}

export default { id: "croak-usage-panel", tui }
