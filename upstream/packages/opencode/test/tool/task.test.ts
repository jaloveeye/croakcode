import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@croakcode/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { TaskTool, delegatedPromptParts, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    Bus.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    RuntimeFlags.layer(flags),
  )

const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))

// SEC-03: operator-controlled connection mode, read on every Config.get().
const connMode: { current: "gate" | "direct" } = { current: "gate" }
afterEach(() => {
  connMode.current = "gate"
})
const ModeConfig = Layer.effect(
  Config.Service,
  Effect.gen(function* () {
    const real = yield* Config.Service
    return Config.Service.of({
      ...real,
      get: () => real.get().pipe(Effect.map((cfg) => ({ ...cfg, connection: { mode: connMode.current } }))),
    })
  }),
).pipe(Layer.provide(Config.defaultLayer))
const modeBackground = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    Bus.defaultLayer,
    ModeConfig,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    RuntimeFlags.layer({ experimentalBackgroundSubagents: true }),
  ),
)

// Persist a child assistant reply stamped with `origin`, as the real prompt loop does.
const persistChildReply = Effect.fn("TaskToolTest.persistChildReply")(function* (
  input: SessionPrompt.PromptInput,
  text: string,
  origin: "gate" | "user",
) {
  const session = yield* Session.Service
  const message = reply(input, text)
  yield* session.updateMessage(message.info)
  for (const part of message.parts) yield* session.updatePart({ ...part, metadata: { origin } } as MessageV2.Part)
  return message
})

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("tool.task", () => {
  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
    }),
  )

  // --- SC-01 P0-C: task_id must not cross parent/agent ownership -----------
  it.instance("execute rejects a task_id owned by a different parent session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      // A child belonging to a DIFFERENT parent session.
      const foreignParent = yield* sessions.create({ title: "foreign-parent" })
      const foreignChild = yield* sessions.create({ parentID: foreignParent.id, title: "foreign child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompted = false
      const promptOps = stubOps({ onPrompt: () => (prompted = true) })

      const exit = yield* def
        .execute(
          { description: "hijack", prompt: "do something", subagent_type: "general", task_id: foreignChild.id },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(prompted).toBe(false)
      // The foreign child still belongs to its original parent.
      const still = yield* sessions.get(foreignChild.id)
      expect(still.parentID).toBe(foreignParent.id)
    }),
  )

  it.instance("execute rejects a task_id whose session agent differs from subagent_type", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "explore child", agent: "explore" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompted = false
      const promptOps = stubOps({ onPrompt: () => (prompted = true) })

      const exit = yield* def
        .execute(
          { description: "mismatch", prompt: "do something", subagent_type: "general", task_id: child.id },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(prompted).toBe(false)
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        // SC-01: the inherited ceiling is appended LAST (so findLast makes it
        // authoritative), which may reorder rules relative to creation order.
        // Assert the rule set, not the order.
        const normalize = (rules: { permission: string; pattern: string; action: string }[]) =>
          [...rules].sort((a, b) => (a.permission + a.pattern + a.action).localeCompare(b.permission + b.pattern + b.action))
        expect(normalize(child.permission ?? [])).toEqual(
          normalize([
            { permission: "todowrite", pattern: "*", action: "deny" },
            { permission: "bash", pattern: "*", action: "allow" },
            { permission: "read", pattern: "*", action: "allow" },
          ]),
        )
        expect(seen?.tools).toEqual({
          todowrite: false,
          bash: false,
          read: false,
        })
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  // SEC-03: provenance is decided by the security context that produced the
  // result, not by the mode at the moment it is injected into the parent.
  const runBackground = Effect.fn("TaskToolTest.runBackground")(function* (
    child: (input: SessionPrompt.PromptInput) => Effect.Effect<MessageV2.WithParts, never, Session.Service>,
  ) {
    const jobs = yield* BackgroundJob.Service
    const session = yield* Session.Service
    const { chat, assistant } = yield* seed()
    const def = yield* (yield* TaskTool).init()
    const injected = defer<SessionPrompt.PromptInput>()

    const result = yield* def.execute(
      { description: "inspect bug", prompt: "look", subagent_type: "general", background: true },
      {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: {
          promptOps: {
            ...stubOps(),
            prompt: (input) => {
              if (input.sessionID !== chat.id) return child(input).pipe(Effect.provideService(Session.Service, session))
              injected.resolve(input)
              return Effect.succeed(reply(input, "ack"))
            },
          } satisfies TaskPromptOps,
        },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      },
    )
    const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 2_000 })
    expect(waited.info?.status).toBe("completed")
    const input = yield* Effect.promise(() => injected.promise)
    const part = input.parts[0] as { metadata?: { origin?: string } }
    return part.metadata?.origin
  })

  modeBackground.instance("SEC-03 background result launched under gate stays gate after a switch to direct", () =>
    Effect.gen(function* () {
      connMode.current = "gate"
      const origin = yield* runBackground((input) =>
        Effect.sync(() => {
          // The operator switches to direct while the sub-agent is still running.
          connMode.current = "direct"
          return reply(input, "GATE_CONTEXT_RESULT")
        }),
      )
      expect(origin).toBe("gate")
    }),
  )

  modeBackground.instance("SEC-03 background result is gate when the child produced gate content", () =>
    Effect.gen(function* () {
      connMode.current = "direct"
      const origin = yield* runBackground((input) =>
        Effect.gen(function* () {
          // Mode flipped to gate and back during the run; the child's own turn was gate-stamped.
          return yield* persistChildReply(input, "GATE_CONTEXT_RESULT", "gate")
        }),
      )
      expect(origin).toBe("gate")
    }),
  )

  modeBackground.instance("SEC-03 background result from a pure direct run stays user", () =>
    Effect.gen(function* () {
      connMode.current = "direct"
      const origin = yield* runBackground((input) => persistChildReply(input, "direct result", "user"))
      expect(origin).toBe("user")
    }),
  )

  modeBackground.instance("SEC-03 foreground result reports gate provenance when the child produced gate content", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()
      connMode.current = "direct"

      const result = yield* def.execute(
        { description: "inspect bug", prompt: "look", subagent_type: "general" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: (input) =>
                persistChildReply(input, "GATE_CONTEXT_RESULT", "gate").pipe(
                  Effect.provideService(Session.Service, session),
                ),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      expect((result.metadata as { origin?: string }).origin).toBe("gate")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )

  // SC-01: TaskTool MUST forward the parent-derived restrictions to the child
  // prompt as `inheritedPermission` (task.ts:185-199). This is what prevents
  // the child tools-map from relaxing a plan parent's `edit: deny`.
  it.instance(
    "SC-01: task forwards inheritedPermission (parent edit-deny) to child prompt",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const agents = yield* Agent.Service
        const plan = yield* agents.get("plan")
        const general = yield* agents.get("general")
        expect(plan).toBeDefined()
        expect(general).toBeDefined()

        // Parent session running the `plan` agent.
        const chat = yield* sessions.create({ title: "plan-parent", agent: "plan" })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "plan",
          model: ref,
          time: { created: Date.now() },
        })
        const assistant: MessageV2.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: user.id,
          sessionID: chat.id,
          mode: "plan",
          agent: "plan",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
        }
        yield* sessions.updateMessage(assistant)

        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        yield* def.execute(
          { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "plan",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(seen).toBeDefined()
        const inherited = seen?.inheritedPermission ?? []
        // The plan agent's `edit: deny` must be forwarded to the child prompt.
        expect(
          inherited.some((r) => r.permission === "edit" && r.action === "deny"),
        ).toBe(true)
        // The child session must also carry the restriction at creation.
        const childID = seen?.sessionID
        expect(childID).toBeDefined()
        const child = yield* sessions.get(childID!)
        expect(
          (child.permission ?? []).some((r) => r.permission === "edit" && r.action === "deny"),
        ).toBe(true)
      }),
  )

  // SC-03: a default sub-agent (no `task` rule) must NOT be able to re-delegate.
  // deriveSubagentSessionPermission injects `task: deny` into the child session;
  // at execution ctx.ask (session-last merge + findLast) must deny "task".
  it.instance(
    "SC-03: general subagent has task denied (no unauthorised re-delegation)",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const agents = yield* Agent.Service
        const general = yield* agents.get("general")
        expect(general).toBeDefined()

        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        yield* def.execute(
          { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(seen!.sessionID)
        // Session-level injected task deny.
        expect((child.permission ?? []).some((r) => r.permission === "task" && r.action === "deny")).toBe(true)
        // Effective execution ruleset denies "task" (session/tools.ts merge order).
        const effective = Permission.merge(general!.permission, child.permission ?? [])
        expect(Permission.evaluate("task", "*", effective).action).toBe("deny")
      }),
  )

  // SEC-02: the agent that actually executes the `task` tool (`ctx.agent`) and
  // the agent recorded on the session may disagree. The child must inherit the
  // edit-class restrictions of BOTH (fail-closed): no scenario may relax a
  // restriction that originated from the executing agent.
  const runTaskForAgents = Effect.fn("TaskToolTest.runTaskForAgents")(function* (input: {
    sessionAgent?: string
    ctxAgent: string
  }) {
    const sessions = yield* Session.Service
    const title = `sec02-${input.sessionAgent ?? "unset"}-${input.ctxAgent}`
    const chat = yield* sessions.create({ title, ...(input.sessionAgent ? { agent: input.sessionAgent } : {}) })
    const user = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: chat.id,
      agent: input.ctxAgent,
      model: ref,
      time: { created: Date.now() },
    })
    const assistant: MessageV2.Assistant = {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: user.id,
      sessionID: chat.id,
      mode: input.ctxAgent,
      agent: input.ctxAgent,
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
    }
    yield* sessions.updateMessage(assistant)

    const tool = yield* TaskTool
    const def = yield* tool.init()
    let seen: SessionPrompt.PromptInput | undefined
    const promptOps = stubOps({ onPrompt: (i) => (seen = i) })
    yield* def.execute(
      { description: "inspect", prompt: "look into it", subagent_type: "general" },
      {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: input.ctxAgent,
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      },
    )
    return { seen, chat }
  })

  const hasEditDeny = (rules: Permission.Ruleset | undefined) =>
    (rules ?? []).some((r) => r.permission === "edit" && r.action === "deny")

  it.instance(
    "SEC-02: session.agent=build, ctx.agent=plan inherits plan edit-deny",
    () =>
      Effect.gen(function* () {
        const { seen } = yield* runTaskForAgents({ sessionAgent: "build", ctxAgent: "plan" })
        expect(seen).toBeDefined()
        expect(hasEditDeny(seen?.inheritedPermission)).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "SEC-02: session.agent unset, ctx.agent=plan still inherits plan edit-deny",
    () =>
      Effect.gen(function* () {
        const { seen } = yield* runTaskForAgents({ ctxAgent: "plan" })
        expect(seen).toBeDefined()
        expect(hasEditDeny(seen?.inheritedPermission)).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "SEC-02: session.agent=plan, ctx.agent=build keeps plan edit-deny (fail-closed)",
    () =>
      Effect.gen(function* () {
        const { seen } = yield* runTaskForAgents({ sessionAgent: "plan", ctxAgent: "build" })
        expect(seen).toBeDefined()
        // Even though build allows edits, the plan restriction recorded on the
        // session must not be silently dropped.
        expect(hasEditDeny(seen?.inheritedPermission)).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "SEC-02: resumed child keeps the ceiling derived from ctx.agent=plan",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "sec02-resume" })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        const assistant: MessageV2.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: user.id,
          sessionID: chat.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
        }
        yield* sessions.updateMessage(assistant)
        const child = yield* sessions.create({ parentID: chat.id, title: "child", agent: "general" })

        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (i) => (seen = i) })
        yield* def.execute(
          { description: "resume", prompt: "continue", subagent_type: "general", task_id: child.id },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "plan",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        expect(seen).toBeDefined()
        expect(hasEditDeny(seen?.inheritedPermission)).toBe(true)
      }),
    { git: true },
  )
})

describe("CX-05 delegatedPromptParts", () => {
  test("turns file parts into a text pointer and keeps other parts", () => {
    const parts = delegatedPromptParts([
      { type: "text", text: "summarize" },
      { type: "file", url: "file:///etc/passwd", filename: "/etc/passwd", mime: "text/plain" },
      { type: "agent", name: "explore" },
    ])
    expect(parts).toHaveLength(3)
    expect(parts[0]).toEqual({ type: "text", text: "summarize" })
    expect(parts[1].type).toBe("text")
    expect(parts.some((part) => part.type === "file")).toBe(false)
    expect(parts[1].type === "text" && parts[1].text).toContain("/etc/passwd")
    expect(parts[1].type === "text" && parts[1].text).toContain("read tool")
    expect(parts[2]).toEqual({ type: "agent", name: "explore" })
  })
})
