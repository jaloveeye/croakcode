// SEC-03 no-fixture E2E: gate context must never reach a direct provider.
//
// Unlike tests/phase3-context-e2e.test.mjs, nothing here hand-tags `origin`.
// Every message is produced by the real prompt loop, stamped by the real
// processor, persisted to SQLite, read back, and converted into the HTTP body
// the provider receives (captured by TestLLMServer). The only test seam is the
// effective connection mode, which an operator can change between turns by
// editing `connection.mode`; `mode.current` simulates that edit.
import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { AppFileSystem } from "@croakcode/core/filesystem"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import * as Log from "@croakcode/core/util/log"
import { CrossSpawnSpawner } from "@croakcode/core/cross-spawn-spawner"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { Reference } from "../../src/reference/reference"
import { RepositoryCache } from "../../src/reference/repository-cache"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"

void Log.init({ print: false })

const ref = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }

// Operator-controlled connection mode. Read on every Config.get(), exactly like
// a config edit picked up between turns.
const mode: { current: "gate" | "direct" } = { current: "gate" }
afterEach(() => {
  mode.current = "gate"
})

const ModeConfig = Layer.effect(
  Config.Service,
  Effect.gen(function* () {
    const real = yield* Config.Service
    return Config.Service.of({
      ...real,
      get: () => real.get().pipe(Effect.map((cfg) => ({ ...cfg, connection: { mode: mode.current } }))),
    })
  }),
).pipe(Layer.provide(Config.defaultLayer))

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

function makePrompt() {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    ModeConfig,
    ProviderSvc.defaultLayer,
    lsp,
    mcp,
    AppFileSystem.defaultLayer,
    BackgroundJob.defaultLayer,
    status,
    SyncEvent.defaultLayer,
    EventV2Bridge.defaultLayer,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const flags = RuntimeFlags.layer({ experimentalEventSystem: true })
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(RepositoryCache.defaultLayer),
    Layer.provide(Git.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(flags),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(Image.defaultLayer),
    Layer.provide(flags),
    Layer.provideMerge(deps),
  )
  const compact = SessionCompaction.layer.pipe(Layer.provide(flags), Layer.provideMerge(proc), Layer.provideMerge(deps))
  return SessionPrompt.layer.pipe(
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(summary),
    Layer.provideMerge(run),
    Layer.provideMerge(compact),
    Layer.provideMerge(proc),
    Layer.provideMerge(registry),
    Layer.provideMerge(trunc),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(SystemPrompt.defaultLayer),
    Layer.provide(flags),
    Layer.provideMerge(deps),
  )
}

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, makePrompt()))

function providerCfg(url: string) {
  return {
    $schema: "https://croakcode.ai/config.json",
    // Summarize the whole history so every gate turn lands in the compaction request.
    compaction: { auto: false, tail_turns: 0 },
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
  }
}

const setup = Effect.fn("sec03.setup")(function* () {
  const { directory } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* AppFileSystem.Service
  yield* fs.writeWithDirs(path.join(directory, "croakcode.json"), JSON.stringify(providerCfg(llm.url)))
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const session = yield* sessions.create({
    title: "sec03 e2e",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
  const turn = Effect.fn("sec03.turn")(function* (text: string, answer: string) {
    yield* prompt.prompt({ sessionID: session.id, agent: "build", noReply: true, parts: [{ type: "text", text }] })
    yield* llm.text(answer)
    return yield* prompt.loop({ sessionID: session.id })
  })
  return { llm, prompt, sessions, session, turn }
})

// Captured HTTP request bodies, serialized so a substring check covers every field.
const bodies = (inputs: Record<string, unknown>[]) => inputs.map((input) => JSON.stringify(input))

it.instance("direct request after a real gate turn omits gate output and keeps direct history", () =>
  Effect.gen(function* () {
    const { llm, turn } = yield* setup()

    mode.current = "gate"
    yield* turn("question one", "GATE_SECRET_ALPHA")

    mode.current = "direct"
    yield* turn("question two", "DIRECT_ANSWER_TWO")
    yield* turn("question three", "DIRECT_ANSWER_THREE")

    const sent = bodies(yield* llm.inputs)
    expect(sent).toHaveLength(3)
    // The gate turn's own request naturally carries nothing secret yet.
    expect(sent[1]).not.toContain("GATE_SECRET_ALPHA")
    expect(sent[2]).not.toContain("GATE_SECRET_ALPHA")
    // User input is always replayed.
    expect(sent[2]).toContain("question one")
    // Direct-produced history must survive the direct filter.
    expect(sent[2]).toContain("DIRECT_ANSWER_TWO")
  }),
)

it.instance("gate mode replays its own gate history", () =>
  Effect.gen(function* () {
    const { llm, turn } = yield* setup()
    mode.current = "gate"
    yield* turn("question one", "GATE_SECRET_ALPHA")
    yield* turn("question two", "GATE_ANSWER_TWO")
    const sent = bodies(yield* llm.inputs)
    expect(sent[1]).toContain("GATE_SECRET_ALPHA")
  }),
)

it.instance("direct compaction request omits gate history", () =>
  Effect.gen(function* () {
    const { llm, prompt, session, turn } = yield* setup()
    const compact = yield* SessionCompaction.Service

    mode.current = "gate"
    yield* turn("question one", "GATE_SECRET_ALPHA")

    mode.current = "direct"
    yield* turn("question two", "DIRECT_ANSWER_TWO")

    yield* compact.create({ sessionID: session.id, agent: "build", model: ref, auto: false })
    yield* llm.text("DIRECT_SUMMARY")
    yield* prompt.loop({ sessionID: session.id })

    const sent = bodies(yield* llm.inputs)
    const compaction = sent.at(-1)!
    expect(compaction).toContain("anchored summary")
    expect(compaction).not.toContain("GATE_SECRET_ALPHA")
    expect(compaction).toContain("DIRECT_ANSWER_TWO")
  }),
)

it.instance("direct compaction does not reuse a gate-produced previous summary", () =>
  Effect.gen(function* () {
    const { llm, prompt, session, turn } = yield* setup()
    const compact = yield* SessionCompaction.Service

    mode.current = "gate"
    yield* turn("question one", "GATE_SECRET_ALPHA")
    yield* compact.create({ sessionID: session.id, agent: "build", model: ref, auto: false })
    yield* llm.text("GATE_SUMMARY_SECRET")
    yield* prompt.loop({ sessionID: session.id })

    mode.current = "direct"
    yield* turn("question two", "DIRECT_ANSWER_TWO")
    yield* compact.create({ sessionID: session.id, agent: "build", model: ref, auto: false })
    yield* llm.text("DIRECT_SUMMARY")
    yield* prompt.loop({ sessionID: session.id })

    const sent = bodies(yield* llm.inputs)
    const compaction = sent.at(-1)!
    expect(compaction).toContain("anchored summary")
    expect(compaction).not.toContain("GATE_SUMMARY_SECRET")
    expect(compaction).not.toContain("GATE_SECRET_ALPHA")
  }),
)

it.instance("direct request after a gate compaction omits the gate summary", () =>
  Effect.gen(function* () {
    const { llm, prompt, session, turn } = yield* setup()
    const compact = yield* SessionCompaction.Service

    mode.current = "gate"
    yield* turn("question one", "GATE_SECRET_ALPHA")
    yield* compact.create({ sessionID: session.id, agent: "build", model: ref, auto: false })
    yield* llm.text("GATE_SUMMARY_SECRET")
    yield* prompt.loop({ sessionID: session.id })

    mode.current = "direct"
    yield* turn("question two", "DIRECT_ANSWER_TWO")

    const sent = bodies(yield* llm.inputs)
    expect(sent.at(-1)).not.toContain("GATE_SUMMARY_SECRET")
    expect(sent.at(-1)).not.toContain("GATE_SECRET_ALPHA")
  }),
)
