import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("CROAKCODE_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: Config.boolean(name).pipe(Config.option) }).pipe(
    Config.map((flags) => Option.getOrElse(flags.enabled, () => flags.experimental)),
  )

export class Service extends ConfigService.Service<Service>()("@croakcode/RuntimeFlags", {
  autoShare: bool("CROAKCODE_AUTO_SHARE"),
  pure: bool("CROAKCODE_PURE"),
  disableDefaultPlugins: bool("CROAKCODE_DISABLE_DEFAULT_PLUGINS"),
  disableChannelDb: bool("CROAKCODE_DISABLE_CHANNEL_DB"),
  disableEmbeddedWebUi: bool("CROAKCODE_DISABLE_EMBEDDED_WEB_UI"),
  // Remote web UI host to proxy when no embedded UI is bundled. Unset by
  // default: croakcode has no hosted web UI, and a built-in domain nobody
  // controls would receive proxied requests.
  webUiUrl: Config.string("CROAKCODE_WEB_UI_URL").pipe(
    Config.map((value) => value.trim() || undefined),
    Config.orElse(() => Config.succeed(undefined)),
  ),
  disableExternalSkills: bool("CROAKCODE_DISABLE_EXTERNAL_SKILLS"),
  disableLspDownload: bool("CROAKCODE_DISABLE_LSP_DOWNLOAD"),
  skipMigrations: bool("CROAKCODE_SKIP_MIGRATIONS"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("CROAKCODE_DISABLE_CLAUDE_CODE"),
    direct: bool("CROAKCODE_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("CROAKCODE_DISABLE_CLAUDE_CODE"),
    direct: bool("CROAKCODE_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: bool("CROAKCODE_ENABLE_EXA"),
    legacy: bool("CROAKCODE_EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("CROAKCODE_ENABLE_PARALLEL"),
    legacy: bool("CROAKCODE_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: bool("CROAKCODE_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("CROAKCODE_ENABLE_QUESTION_TOOL"),
  experimentalScout: enabledByExperimental("CROAKCODE_EXPERIMENTAL_SCOUT"),
  experimentalBackgroundSubagents: enabledByExperimental("CROAKCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("CROAKCODE_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("CROAKCODE_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("CROAKCODE_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("CROAKCODE_EXPERIMENTAL_PLAN_MODE"),
  experimentalEventSystem: enabledByExperimental("CROAKCODE_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("CROAKCODE_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("CROAKCODE_EXPERIMENTAL_ICON_DISCOVERY"),
  acpNext: bool("CROAKCODE_ACP_NEXT"),
  outputTokenMax: positiveInteger("CROAKCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("CROAKCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  experimentalNativeLlm: bool("CROAKCODE_EXPERIMENTAL_NATIVE_LLM"),
  experimentalWebSockets: bool("CROAKCODE_EXPERIMENTAL_WEBSOCKETS"),
  client: Config.string("CROAKCODE_CLIENT").pipe(Config.withDefault("cli")),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.defaultLayer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const defaultLayer = Service.defaultLayer.pipe(Layer.orDie)

export * as RuntimeFlags from "./runtime-flags"
