import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@croakcode/core/cross-spawn-spawner"
import { ToolRegistry } from "@/tool/registry"
import { Agent } from "@/agent/agent"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { AppFileSystem } from "@croakcode/core/filesystem"
import { Plugin } from "@/plugin"
import { Question } from "@/question"
import { Todo } from "@/session/todo"
import { Skill } from "@/skill"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Provider } from "@/provider/provider"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "@/session/instruction"
import { Bus } from "@/bus"
import { FetchHttpClient } from "effect/unstable/http"
import { Format } from "@/format"
import { Ripgrep } from "@/file/ripgrep"
import * as Truncate from "@/tool/truncate"
import { InstanceState } from "@/effect/instance-state"
import { Reference } from "@/reference/reference"
import { RepositoryCache } from "@/reference/repository-cache"
import { ProviderID, ModelID } from "@/provider/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"

const node = CrossSpawnSpawner.defaultLayer
const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".croakcode")])),
})

const registryLayer = () =>
  ToolRegistry.layer
    .pipe(
      Layer.provide(configLayer),
      Layer.provide(Plugin.defaultLayer),
      Layer.provide(Question.defaultLayer),
      Layer.provide(Todo.defaultLayer),
      Layer.provide(Skill.defaultLayer),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(Session.defaultLayer),
      Layer.provide(Layer.mergeAll(SessionStatus.defaultLayer, BackgroundJob.defaultLayer)),
      Layer.provide(Provider.defaultLayer),
      Layer.provide(Layer.mergeAll(Git.defaultLayer, RepositoryCache.defaultLayer)),
      Layer.provide(Reference.defaultLayer),
      Layer.provide(LSP.defaultLayer),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(AppFileSystem.defaultLayer),
      Layer.provide(Bus.layer),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Format.defaultLayer),
      Layer.provide(node),
      Layer.provide(Ripgrep.defaultLayer),
      Layer.provide(Truncate.defaultLayer),
    )
    .pipe(Layer.provide(RuntimeFlags.layer({})))

const it = testEffect(Layer.mergeAll(registryLayer(), node, Agent.defaultLayer))

afterEach(async () => {
  await disposeAllInstances()
})

const toolIdsFor = (agent: Agent.Info) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const tools = yield* registry.tools({
      providerID: ProviderID.openai,
      modelID: ModelID.make("test"),
      agent,
    })
    return tools.map((tool) => tool.id)
  })

const withPermission = (base: Agent.Info, permission: Agent.Info["permission"]): Agent.Info => ({
  ...base,
  permission,
})

describe("tool.registry permission gate (§4.7)", () => {
  it.instance("excludes a tool denied by agent permission", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      if (!build) throw new Error("build agent not found")
      const ids = yield* toolIdsFor(
        withPermission(build, [{ permission: "read", pattern: "*", action: "deny" }]),
      )
      expect(ids).not.toContain("read")
    }),
  )

  it.instance("exposes a tool marked ask (ask means visible, approval at execution)", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      if (!build) throw new Error("build agent not found")
      const ids = yield* toolIdsFor(
        withPermission(build, [{ permission: "write", pattern: "*", action: "ask" }]),
      )
      expect(ids).toContain("write")
    }),
  )

  it.instance("exposes tools when the ruleset is empty (evaluate falls back to ask)", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      if (!build) throw new Error("build agent not found")
      const ids = yield* toolIdsFor(withPermission(build, []))
      expect(ids).toContain("read")
      expect(ids).toContain("write")
    }),
  )
})
