import { afterEach, expect, test } from "bun:test"
import { createGuard, GUARD_MARK } from "./controller.tsx"

/** Minimal stand-in for the TUI plugin API. */
function fakeApi() {
  const handlers = new Map<string, ((e: any) => void)[]>()
  const status: Record<string, string> = {}
  const permissions: Record<string, unknown[]> = {}
  const calls: { op: string; args: any }[] = []
  const toasts: any[] = []
  const api = {
    event: {
      on(type: string, fn: (e: any) => void) {
        handlers.set(type, [...(handlers.get(type) ?? []), fn])
        return () => {}
      },
    },
    state: {
      provider: [{ id: "litellm-head", models: { default: { variants: { direct: {}, high: {} } } } }],
      session: {
        get: (id: string) => (id === "child" ? { id, parentID: "s1" } : { id }),
        status: (id: string) => ({ type: status[id] ?? "idle" }),
        permission: (id: string) => permissions[id] ?? [],
        question: () => [],
        messages: () => [{ role: "user", agent: "dev-main", model: { providerID: "litellm-head", modelID: "default", variant: "high" } }],
      },
    },
    client: {
      session: {
        abort: async (args: any) => {
          calls.push({ op: "abort", args })
          status[args.sessionID] = "idle"
          emit("session.status", { sessionID: args.sessionID, status: { type: "idle" } })
        },
        promptAsync: async (args: any) => void calls.push({ op: "prompt", args }),
      },
    },
    ui: { toast: (t: any) => void toasts.push(t), dialog: { replace() {}, clear() {} } },
    keymap: { registerLayer() {} },
    route: { current: { name: "home" } },
  }
  const emit = (type: string, properties: any) => handlers.get(type)?.forEach((fn) => fn({ type, properties }))
  const busy = (id: string) => {
    status[id] = "busy"
    emit("session.status", { sessionID: id, status: { type: "busy" } })
  }
  return { api, emit, busy, calls, toasts, permissions }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let disposers: (() => void)[] = []
afterEach(() => {
  disposers.forEach((d) => d())
  disposers = []
})

test("a decode stall counts down, then aborts and continues", async () => {
  const f = fakeApi()
  const g = createGuard(f.api, { decodeStallMs: 50, countdownMs: 80, tickMs: 10 }, () => null)
  disposers.push(g.dispose)
  f.busy("s1")
  f.emit("message.part.updated", { part: { type: "step-start", sessionID: "s1", messageID: "m1" } })
  await sleep(90)
  expect(g.states().s1?.kind).toBe("countdown")
  await sleep(150)
  expect(f.calls.map((c) => c.op)).toEqual(["abort", "prompt"])
  const prompt = f.calls[1].args
  expect(prompt.agent).toBe("dev-main")
  expect(prompt.model).toEqual({ providerID: "litellm-head", modelID: "default" })
  expect(prompt.parts[0].text.startsWith(GUARD_MARK)).toBe(true)
})

test("clicking the avatar during the countdown cancels the restart", async () => {
  const f = fakeApi()
  const g = createGuard(f.api, { decodeStallMs: 50, countdownMs: 80, tickMs: 10 }, () => null)
  disposers.push(g.dispose)
  f.busy("s1")
  f.emit("message.part.updated", { part: { type: "step-start", sessionID: "s1", messageID: "m1" } })
  await sleep(90)
  g.click("s1")
  await sleep(150)
  expect(f.calls).toEqual([])
  expect(g.states().s1).toBeUndefined()
})

test("a slow first token only asks", async () => {
  const f = fakeApi()
  const g = createGuard(f.api, { prefillMinMs: 50, tickMs: 10 }, () => null)
  disposers.push(g.dispose)
  f.busy("s1")
  await sleep(100)
  expect(g.states().s1).toMatchObject({ kind: "ask", aborted: false })
  expect(f.calls).toEqual([])
})

test("a repeat loop aborts and continues once, then stops and asks", async () => {
  const f = fakeApi()
  const g = createGuard(f.api, { tickMs: 1000 }, () => null)
  disposers.push(g.dispose)
  const unit = "같은 생각을 다시 반복한다. 이 단계에서 확인할 것은 앞에서 확인한 것과 같다. 그러니 다시 처음부터 확인한다. "
  const loop = async (partID: string) => {
    f.busy("s1")
    f.emit("message.part.updated", { part: { type: "reasoning", id: partID, sessionID: "s1" } })
    for (let i = 0; i < 40; i++) f.emit("message.part.delta", { sessionID: "s1", partID, field: "text", delta: unit })
    await sleep(50)
  }
  await loop("r1")
  expect(f.calls.map((c) => c.op)).toEqual(["abort", "prompt"])
  await loop("r2")
  expect(f.calls.map((c) => c.op)).toEqual(["abort", "prompt", "abort"])
  expect(g.states().s1).toMatchObject({ kind: "ask", aborted: true })
})

test("sub-agent sessions are watched but never restarted", async () => {
  const f = fakeApi()
  const g = createGuard(f.api, { decodeStallMs: 30, countdownMs: 30, tickMs: 10 }, () => null)
  disposers.push(g.dispose)
  f.busy("child")
  f.emit("message.part.updated", { part: { type: "step-start", sessionID: "child", messageID: "m1" } })
  await sleep(120)
  expect(f.calls).toEqual([])
  expect(g.states().child).toBeUndefined()
})

test("a new user prompt resets the restart budget", async () => {
  const f = fakeApi()
  const g = createGuard(f.api, { decodeStallMs: 20, countdownMs: 20, tickMs: 5, maxRestarts: 1 }, () => null)
  disposers.push(g.dispose)
  const stall = async () => {
    f.busy("s1")
    f.emit("message.part.updated", { part: { type: "step-start", sessionID: "s1", messageID: "m" } })
    await sleep(100)
  }
  await stall()
  expect(f.calls.filter((c) => c.op === "prompt")).toHaveLength(1)
  // The guard's own prompt does not reset the budget.
  f.emit("message.updated", { info: { id: "u-guard", role: "user", sessionID: "s1" } })
  await stall()
  expect(f.calls.filter((c) => c.op === "prompt")).toHaveLength(1)
  expect(g.states().s1?.kind).toBe("ask")
  // A real user prompt does.
  f.emit("message.updated", { info: { id: "u-real", role: "user", sessionID: "s1" } })
  await stall()
  expect(f.calls.filter((c) => c.op === "prompt")).toHaveLength(2)
})

test("overthinking continues with the same variant, then without thinking, then asks", async () => {
  const f = fakeApi()
  const g = createGuard(f.api, { tickMs: 1000 }, () => null)
  disposers.push(g.dispose)
  const cut = async (n: number) => {
    f.emit("message.part.updated", {
      part: { type: "step-finish", sessionID: "s1", messageID: `m${n}`, reason: "length", tokens: { output: 0, reasoning: 16384 } },
    })
    await sleep(50)
  }
  await cut(1)
  let prompts = f.calls.filter((c) => c.op === "prompt")
  expect(prompts).toHaveLength(1)
  // The user's variant keeps the prompt cache.
  expect(prompts[0].args.variant).toBe("high")
  expect(prompts[0].args.parts[0].text.startsWith(GUARD_MARK)).toBe(true)
  await cut(2)
  prompts = f.calls.filter((c) => c.op === "prompt")
  expect(prompts).toHaveLength(2)
  expect(prompts[1].args.variant).toBe("direct")
  await cut(3)
  expect(f.calls.filter((c) => c.op === "prompt")).toHaveLength(2)
  expect(g.states().s1).toMatchObject({ kind: "ask", aborted: true })
})

test("a normal length stop with an answer is left alone", async () => {
  const f = fakeApi()
  const g = createGuard(f.api, { tickMs: 1000 }, () => null)
  disposers.push(g.dispose)
  f.emit("message.part.updated", {
    part: { type: "step-finish", sessionID: "s1", messageID: "m1", reason: "length", tokens: { output: 900, reasoning: 100 } },
  })
  await sleep(50)
  expect(f.calls).toEqual([])
})

test("a pending permission is never treated as a stall", async () => {
  const f = fakeApi()
  const g = createGuard(f.api, { decodeStallMs: 30, countdownMs: 30, tickMs: 5 }, () => null)
  disposers.push(g.dispose)
  f.busy("s1")
  f.emit("message.part.updated", { part: { type: "step-start", sessionID: "s1", messageID: "m1" } })
  f.permissions.s1 = [{ id: "perm1" }]
  await sleep(150)
  expect(f.calls).toEqual([])
  expect(g.states().s1).toBeUndefined()
})

test("a countdown is dropped when a permission request appears", async () => {
  const f = fakeApi()
  const g = createGuard(f.api, { decodeStallMs: 20, countdownMs: 200, tickMs: 5 }, () => null)
  disposers.push(g.dispose)
  f.busy("s1")
  f.emit("message.part.updated", { part: { type: "step-start", sessionID: "s1", messageID: "m1" } })
  await sleep(50)
  expect(g.states().s1?.kind).toBe("countdown")
  f.permissions.s1 = [{ id: "perm1" }]
  await sleep(300)
  expect(f.calls).toEqual([])
  expect(g.states().s1).toBeUndefined()
})
