/** @jsxImportSource @opentui/solid */
// Watches every session for stalls and runaway generation and acts on them.
//
//   confirmed stall (tokens stopped)    -> countdown, then abort and continue; click cancels
//   suspected stall (slow first token)  -> ask; click opens a choice dialog
//   runaway (repeat or over-long part)  -> abort now, continue once; ask the second time
//
// Only root sessions are restarted. A sub-agent session ends with its parent.
import { createSignal } from "solid-js"
import { defaultGuardConfig, SessionWatch, type GuardConfig, type PartKind, type Verdict } from "./guard.ts"

export const GUARD_MARK = "[croak-guard]"

const CONTINUE_STALL = `${GUARD_MARK} 직전 응답이 멈춰서 중단했다. 이미 완료한 작업과 도구 결과를 확인하라. 완료한 작업은 반복하지 말고 남은 작업을 계속하라.`
const CONTINUE_DIRECT = `${GUARD_MARK} 직전 응답이 답 없이 추론만 길게 이어져 중단했다. 더 추론하지 말고 지금까지 파악한 내용으로 바로 답하라. 요청한 결과물을 먼저 제시하라.`
const CONTINUE_LOOP = `${GUARD_MARK} 직전 응답에서 같은 내용이 반복되어 중단했다. 같은 문장과 같은 생각을 반복하지 마라. 지금까지의 결론을 짧게 정리하고 남은 작업을 진행하라.`

export type GuardState =
  | { kind: "countdown"; until: number; reason: string }
  | { kind: "ask"; reason: string; aborted: boolean }
  | { kind: "loop"; until: number }

export type GuardOptions = Partial<GuardConfig> & {
  countdownMs?: number
  maxRestarts?: number
  maxLoopContinues?: number
  /** Variant used to continue after overthinking; skipped when the model lacks it. */
  directVariant?: string
  /** Check interval; tests shorten it. */
  tickMs?: number
}

type Api = any

export function createGuard(api: Api, options: GuardOptions, expected: (sessionID: string) => number | null) {
  const cfg: GuardConfig = { ...defaultGuardConfig, ...options }
  const countdownMs = options.countdownMs ?? 10_000
  const maxRestarts = options.maxRestarts ?? 2
  const maxLoopContinues = options.maxLoopContinues ?? 1

  const watches = new Map<string, SessionWatch>()
  const partKinds = new Map<string, PartKind>()
  const restarts = new Map<string, number>()
  const loopContinues = new Map<string, number>()
  const overthinkContinues = new Map<string, number>()
  const ownPrompt = new Set<string>()
  const seenUser = new Set<string>()
  const dismissed = new Set<string>()
  /** Sessions with an abort or restart in progress. */
  const handling = new Set<string>()
  const [states, setStates] = createSignal<Record<string, GuardState | undefined>>({})

  const watch = (id: string) => {
    let w = watches.get(id)
    if (!w) {
      w = new SessionWatch(cfg)
      watches.set(id, w)
    }
    return w
  }
  const setState = (id: string, state: GuardState | undefined) => setStates((all) => ({ ...all, [id]: state }))
  const isRoot = (id: string) => !api.state.session.get(id)?.parentID
  const toast = (variant: string, title: string, message: string) =>
    api.ui.toast({ variant, title, message, duration: 8000 })

  /** Progress resumed: drop stall prompts that no longer apply. */
  const progressed = (id: string) => {
    dismissed.delete(id)
    const s = states()[id]
    if (s && s.kind !== "loop" && !(s.kind === "ask" && s.aborted)) setState(id, undefined)
  }

  async function waitIdle(id: string, ms = 10_000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (api.state.session.status(id)?.type !== "busy") return
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  function lastUser(id: string) {
    const msgs = api.state.session.messages(id)
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") return msgs[i]
  }

  async function abort(id: string) {
    await api.client.session.abort({ sessionID: id }).catch(() => {})
    await waitIdle(id)
  }

  function hasVariant(user: any, name: string) {
    const provider = api.state.provider?.find?.((p: any) => p.id === user?.model?.providerID)
    return Boolean(provider?.models?.[user?.model?.modelID]?.variants?.[name])
  }

  async function restart(id: string, text: string, opts: { direct?: boolean } = {}) {
    const user = lastUser(id)
    await abort(id)
    ownPrompt.add(id)
    restarts.set(id, (restarts.get(id) ?? 0) + 1)
    const direct = options.directVariant ?? "direct"
    const variant = opts.direct && hasVariant(user, direct) ? direct : user?.model?.variant
    await api.client.session.promptAsync({
      sessionID: id,
      agent: user?.agent,
      model: user?.model ? { providerID: user.model.providerID, modelID: user.model.modelID } : undefined,
      variant,
      parts: [{ type: "text", text }],
    })
  }

  /** Runs one abort or restart at a time per session; verdicts during it are ignored. */
  async function exclusive(id: string, fn: () => Promise<void>) {
    if (handling.has(id)) return
    handling.add(id)
    try {
      await fn()
    } finally {
      handling.delete(id)
    }
  }

  /**
   * 1st: keep the variant so the prompt cache still hits, and tell the model to answer.
   * 2nd: switch to the no-thinking variant; slower (cold prefill) but it answers.
   * 3rd: stop and ask.
   */
  async function handleOverthink(id: string) {
    const used = overthinkContinues.get(id) ?? 0
    if (used < 2) {
      overthinkContinues.set(id, used + 1)
      const direct = used === 1
      setState(id, { kind: "loop", until: Date.now() + 8_000 })
      toast(
        "warning",
        direct ? "추론 과다 재발" : "추론 과다",
        direct
          ? "다시 추론만 길어졌다. 추론을 끈 변형으로 바꿔 이어서 진행한다. 캐시를 못 써서 첫 응답이 늦을 수 있다."
          : "답 없이 추론만 길어졌다. 중단하고 바로 답하라고 지시한 뒤 이어서 진행한다.",
      )
      await restart(id, CONTINUE_DIRECT, { direct })
    } else {
      await abort(id)
      setState(id, { kind: "ask", reason: "추론 과다로 중단함", aborted: true })
      toast("error", "추론 과다 반복", "추론을 끈 뒤에도 답이 나오지 않아 중단했다. 아바타를 클릭해 다음 동작을 고른다.")
    }
  }

  async function handleLoop(id: string, v: Extract<Verdict, { kind: "loop" }>) {
    if (v.reason === "overthink") return handleOverthink(id)
    const used = loopContinues.get(id) ?? 0
    const what = v.partKind === "reasoning" ? "추론" : "답변"
    const why = v.reason === "length" ? "길이가 상한을 넘었다" : "같은 내용이 반복된다"
    if (used < maxLoopContinues) {
      loopContinues.set(id, used + 1)
      // Display only; it does not block detecting the next loop.
      setState(id, { kind: "loop", until: Date.now() + 8_000 })
      toast("warning", `${what} 반복 감지`, `${why}. 중단하고 반복하지 말라고 지시한 뒤 이어서 진행한다.`)
      await restart(id, CONTINUE_LOOP)
    } else {
      await abort(id)
      setState(id, { kind: "ask", reason: `${what} 반복으로 중단함`, aborted: true })
      toast("error", `${what} 반복 재발`, `${why}. 중단했다. 아바타를 클릭해 다음 동작을 고른다.`)
    }
  }

  async function onVerdict(id: string, v: Verdict) {
    if (!isRoot(id) || handling.has(id)) return
    const current = states()[id]
    if (v.kind === "loop") {
      if (current?.kind === "ask" && current.aborted) return
      await exclusive(id, () => handleLoop(id, v))
      return
    }
    if (current || dismissed.has(id)) return
    const secs = Math.round(v.idleMs / 1000)
    if (v.confirmed && (restarts.get(id) ?? 0) < maxRestarts) {
      setState(id, { kind: "countdown", until: Date.now() + countdownMs, reason: `토큰이 ${secs}초째 오지 않음` })
      toast(
        "warning",
        "응답 멈춤 감지",
        `토큰이 ${secs}초째 오지 않는다. ${Math.round(countdownMs / 1000)}초 뒤 재시작한다. 아바타를 클릭하면 취소한다.`,
      )
      return
    }
    const reason = v.confirmed ? `토큰이 ${secs}초째 오지 않음 (자동 재시작 ${maxRestarts}회 소진)` : `첫 토큰이 ${secs}초째 오지 않음`
    setState(id, { kind: "ask", reason, aborted: false })
    toast("info", "응답 지연", `${reason}. 아바타를 클릭해 재시작 여부를 고른다.`)
  }

  function openDialog(id: string) {
    const state = states()[id]
    const busy = api.state.session.status(id)?.type === "busy"
    const options = [
      { title: "재시작", description: "현재 요청을 중단하고 남은 작업을 이어서 진행한다", value: "restart" },
      ...(busy ? [{ title: "중단", description: "현재 요청만 중단한다", value: "abort" }] : []),
      { title: "계속 기다리기", description: "이번 지연에는 다시 묻지 않는다", value: "dismiss" },
    ]
    const DialogSelect = api.ui.DialogSelect
    api.ui.dialog.replace(() => (
      <DialogSelect
        title={state?.kind === "ask" ? state.reason : busy ? "세션 조치" : "세션 재시작"}
        options={options}
        skipFilter
        onSelect={(opt: { value: string }) => {
          api.ui.dialog.clear()
          setState(id, undefined)
          if (opt.value === "restart") void exclusive(id, () => restart(id, CONTINUE_STALL))
          if (opt.value === "abort") void exclusive(id, () => abort(id))
          if (opt.value === "dismiss") dismissed.add(id)
        }}
      />
    ))
  }

  /** A permission or question is waiting for the user. */
  function waitingOnUser(id: string) {
    const permissions = api.state.session.permission?.(id) ?? []
    const questions = api.state.session.question?.(id) ?? []
    return permissions.length > 0 || questions.length > 0
  }

  /** Avatar click: cancel a countdown, otherwise offer actions. */
  function click(id: string) {
    const state = states()[id]
    if (state?.kind === "countdown") {
      setState(id, undefined)
      dismissed.add(id)
      toast("info", "자동 재시작 취소", "이번 멈춤에는 다시 묻지 않는다. 진행이 재개되면 감시를 다시 시작한다.")
      return
    }
    if (state?.kind === "ask" || api.state.session.status(id)?.type === "busy") openDialog(id)
  }

  const offs = [
    api.event.on("session.status", (e: any) => {
      const type = e.properties.status?.type
      watch(e.properties.sessionID).setBusy(type === "busy" || type === "retry", Date.now())
    }),
    api.event.on("message.updated", (e: any) => {
      const info = e.properties.info
      if (info?.role !== "user" || seenUser.has(info.id)) return
      seenUser.add(info.id)
      if (ownPrompt.delete(info.sessionID)) return
      // A new prompt from the user starts a fresh budget.
      restarts.delete(info.sessionID)
      loopContinues.delete(info.sessionID)
      overthinkContinues.delete(info.sessionID)
      dismissed.delete(info.sessionID)
      setState(info.sessionID, undefined)
    }),
    api.event.on("message.part.updated", (e: any) => {
      const part = e.properties.part
      if (!part) return
      const w = watch(part.sessionID)
      const now = Date.now()
      if (part.type === "step-start") {
        w.stepStart(now)
        progressed(part.sessionID)
      } else if (part.type === "step-finish") {
        w.stepFinish(now)
        // The output limit ended the step before any answer: the same as overthinking.
        if (part.reason === "length" && (part.tokens?.output ?? 0) === 0) {
          void onVerdict(part.sessionID, { kind: "loop", reason: "overthink", partKind: "reasoning" })
        }
      } else if (part.type === "tool") {
        w.tool(part.callID, part.state?.status, now)
      } else if (part.type === "text" || part.type === "reasoning") {
        partKinds.set(part.id, part.type)
      }
    }),
    api.event.on("message.part.delta", (e: any) => {
      const p = e.properties
      if (p.field !== "text") return
      const v = watch(p.sessionID).delta(p.partID, partKinds.get(p.partID) ?? "text", p.delta, Date.now())
      progressed(p.sessionID)
      if (v) void onVerdict(p.sessionID, v)
    }),
  ]

  const timer = setInterval(() => {
    const now = Date.now()
    for (const [id, w] of watches) {
      const state = states()[id]
      if (state?.kind === "countdown" && waitingOnUser(id)) {
        setState(id, undefined)
        continue
      }
      if (state?.kind === "countdown" && now >= state.until) {
        setState(id, undefined)
        toast("warning", "세션 재시작", `${state.reason}. 중단하고 이어서 진행한다.`)
        void exclusive(id, () => restart(id, CONTINUE_STALL))
        continue
      }
      if (state?.kind === "loop" && now >= state.until) setState(id, undefined)
      if (!w.isBusy) continue
      w.setPaused(waitingOnUser(id), now)
      const v = w.check(now, expected(id))
      if (v) void onVerdict(id, v)
    }
  }, options.tickMs ?? 1000)

  api.keymap.registerLayer({
    commands: [
      {
        name: "croak.session.restart",
        title: "Croak: 세션 중단/재시작",
        category: "Session",
        namespace: "palette",
        enabled: () => api.route.current.name === "session",
        run() {
          const id = api.route.current.params?.sessionID
          if (typeof id === "string") openDialog(id)
        },
      },
    ],
  })

  return {
    states,
    click,
    dispose() {
      offs.forEach((off: () => void) => off())
      clearInterval(timer)
    },
  }
}

export type Guard = ReturnType<typeof createGuard>
