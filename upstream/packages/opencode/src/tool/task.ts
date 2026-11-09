import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { Permission } from "../permission"
import type { RunID } from "../delegation/schema"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { connectionFor, containsGateContext, originFor } from "@/session/llm/mode"
import { Cause, Effect, Exit, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { fileURLToPath } from "url"

/**
 * CX-05: a task prompt is written by the model, not the user. Turning its
 * `@file` mentions into file parts would load the file through the prompt's
 * file-part path, which calls the read tool with a no-op permission check and
 * skips `tool.execute.before` hooks. A model could then pull any file into
 * the child's context and the provider request. Keep each mention as text so
 * the child opens it with the read tool, under its own permissions.
 */
export function delegatedPromptParts(
  parts: SessionPrompt.PromptInput["parts"],
): SessionPrompt.PromptInput["parts"] {
  return parts.map((part) => {
    if (part.type !== "file") return part
    const location = part.url.startsWith("file:") ? fileURLToPath(part.url) : part.url
    return {
      type: "text" as const,
      synthetic: true,
      text: `Referenced file: ${part.filename ?? location} (${location}). Use the read tool to open it.`,
    }
  })
}

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  /**
   * Phase 4: issue the child principal, grant and run under the parent's
   * active run. Fails when the parent run cannot delegate.
   */
  delegate(input: {
    parentSessionID: SessionID
    childSessionID: SessionID
    agent: string
    capabilities: Permission.Ruleset
    inherited: Permission.Ruleset
  }): Effect.Effect<{ runId: RunID }, Error>
  /** CX-03: whether the child run's result may be delivered into this session. */
  deliverable(childRunId: RunID, sessionID: SessionID): Effect.Effect<boolean>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "",
  "",
  [
    "Background mode: background=true launches the subagent asynchronously and returns immediately.",
    "Foreground is the default; use it when you need the result before continuing.",
    "Use background only for independent work that can run while you continue elsewhere.",
    "You will be notified automatically when it finishes.",
  ].join(" "),
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description: "Run the agent in the background. You will be notified when it completes.",
  }),
})

function output(sessionID: SessionID, text: string) {
  return [`<task id="${sessionID}" state="completed">`, "<task_result>", text, "</task_result>", "</task>"].join("\n")
}

function backgroundOutput(sessionID: SessionID) {
  return [
    `<task id="${sessionID}" state="running">`,
    "<summary>Background task started</summary>",
    "<task_result>",
    "Background task started. You will be notified automatically when it finishes; do not poll for progress.",
    "Do not duplicate its work. Continue only with non-overlapping work, or stop if there is nothing else useful to do.",
    "</task_result>",
    "</task>",
  ].join("\n")
}

function backgroundMessage(input: {
  sessionID: SessionID
  description: string
  state: "completed" | "error"
  text: string
}) {
  const tag = input.state === "completed" ? "task_result" : "task_error"
  const title =
    input.state === "completed"
      ? `Background task completed: ${input.description}`
      : `Background task failed: ${input.description}`
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    `<summary>${title}</summary>`,
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

// SEC-02: combine the session-recorded agent with the actually-executing agent
// so a subagent inherits the *union* of their deny rules. Returns undefined only
// when neither agent could be resolved. The returned object carries every deny
// rule from both; callers only rely on `.permission`.
function mergeParentAgents(
  a: Agent.Info | undefined,
  b: Agent.Info | undefined,
): Agent.Info | undefined {
  const base = a ?? b
  if (!base) return undefined
  const denies = [...(a?.permission ?? []), ...(b?.permission ?? [])].filter((rule) => rule.action === "deny")
  // De-duplicate identical deny rules; order is irrelevant for deny forwarding.
  const seen = new Set<string>()
  const merged = denies.filter((rule) => {
    const key = `${rule.permission}\u0000${rule.pattern}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { ...base, permission: merged }
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require CROAKCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const session = params.task_id
        ? yield* sessions.get(SessionID.make(params.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      // SC-01 (P0-C): a `task_id` may only resume a child session that this
      // exact parent session owns AND that was created for the same subagent
      // type. Otherwise one parent could hijack another parent's delegated
      // session (inheriting a different authority boundary).
      if (session) {
        if (session.parentID !== ctx.sessionID) {
          return yield* Effect.fail(
            new Error(`Cannot resume task_id ${session.id}: it is not a child of this session`),
          )
        }
        // Reject a type mismatch only when the stored agent is known. Sessions
        // created before this fix (or by non-task paths) may have no `agent`;
        // their authority is still re-derived from the live parent below, so
        // resuming them is not an escalation vector — but hijacking a child of
        // a *different* type is blocked whenever the type is known.
        if (session.agent !== undefined && session.agent !== next.name) {
          return yield* Effect.fail(
            new Error(
              `Cannot resume task_id ${session.id}: it was created for agent "${session.agent}", not "${next.name}"`,
            ),
          )
        }
      }
      const parent = yield* sessions.get(ctx.sessionID)
      const sessionAgent = parent.agent
        ? yield* agent.get(parent.agent).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      // SEC-02: the agent actually executing this tool (`ctx.agent`) and the
      // agent recorded on the session may disagree (e.g. session.agent unset
      // but ctx.agent="plan", or a resumed session created under a different
      // agent). The child must never be *less* restricted than either, so take
      // the union of both agents' deny rules (fail-closed, no relaxation).
      const ctxAgent = ctx.agent
        ? yield* agent.get(ctx.agent).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const parentAgent = mergeParentAgents(sessionAgent, ctxAgent)
      // SC-01: the restrictions inherited from the parent (all parent-agent
      // denies, parent session denies, default todowrite/task denies) are
      // computed once and are IMMUTABLE for the child. They are passed both at
      // session creation and as `inheritedPermission` on the child prompt so the
      // tools map cannot relax them (prompt.ts appends inherited rules last →
      // findLast keeps them authoritative).
      const inheritedPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        parentAgent,
        subagent: next,
      })
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          permission: [
            ...inheritedPermission,
            ...(cfg.experimental?.primary_tools?.map((item) => ({
              pattern: "*",
              action: "allow" as const,
              permission: item,
            })) ?? []),
          ],
          // SC-01: persist the immutable ceiling atomically at creation so the
          // child never exists without it (fail-closed relies on this).
          inheritedPermission,
        }))

      // SC-01: (re)register the immutable inherited ceiling for a resumed child
      // so that later writes to `session.permission` (public Update API) or
      // `prompt()` tools rebuilds (public prompt API) cannot relax it. The
      // ceiling is recomputed from the live parent each run and persisted to
      // the dedicated column (survives restarts and is shared across processes).
      if (session) {
        yield* sessions.setInheritedPermission({ sessionID: nextSession.id, permission: inheritedPermission })
      }

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(Effect.orDie)
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(runInBackground ? { background: true } : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      // SEC-03: the security context the sub-agent runs under, captured at launch.
      const launchConnection = connectionFor(yield* config.get())

      // SEC-03: provenance of the sub-agent's result is decided by the context
      // that produced it, never by the mode at the moment it is consumed. It is
      // gate if the run was launched under gate, or if the child session holds
      // any gate-stamped or unprovable content (the mode can change during a
      // long run; each child step stamps its own snapshot). Fail-closed: if the
      // child history cannot be read, the result is treated as gate.
      const resultOrigin = Effect.fn("TaskTool.resultOrigin")(function* () {
        if (originFor(launchConnection) === "gate") return "gate" as const
        const tainted = yield* sessions.messages({ sessionID: nextSession.id }).pipe(
          Effect.map(containsGateContext),
          Effect.catch(() => Effect.succeed(true)),
        )
        return tainted ? ("gate" as const) : ("user" as const)
      })

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const parts = delegatedPromptParts(yield* ops.resolvePromptParts(params.prompt))
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          agent: next.name,
          inheritedPermission,
          tools: {
            ...(next.permission.some((rule) => rule.permission === "todowrite") ? {} : { todowrite: false }),
            ...(next.permission.some((rule) => rule.permission === id) ? {} : { task: false }),
            ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
          },
          parts,
        })
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        // CX-03: deliver only into the session of the run that delegated.
        if (!(yield* ops.deliverable(childRunId, ctx.sessionID))) return
        const currentParent = yield* sessions.get(ctx.sessionID)
        // SEC-03: the injected sub-agent result is model/tool output. Stamp it
        // with the provenance of the run that produced it so a later direct-mode
        // request cannot replay gate context as trusted user input.
        const origin = yield* resultOrigin()
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            parts: [
              {
                type: "text",
                synthetic: true,
                metadata: { origin },
                text: backgroundMessage({
                  sessionID: nextSession.id,
                  description: params.description,
                  state,
                  text,
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const existing = yield* background.get(nextSession.id)
      if (existing?.status === "running") {
        return yield* Effect.fail(new Error(`Task ${nextSession.id} is already running.`))
      }

      // Phase 4 Task 6: the child runs only under an explicit grant from the
      // parent's active run (INV-5.4). Covers foreground, background and resume.
      const { runId: childRunId } = yield* ops.delegate({
        parentSessionID: ctx.sessionID,
        childSessionID: nextSession.id,
        agent: next.name,
        capabilities: next.permission,
        inherited: inheritedPermission,
      })

      if (runInBackground) {
        const info = yield* background.start({
          id: nextSession.id,
          type: id,
          title: params.description,
          metadata,
          run: runTask().pipe(
            Effect.tap((text) => inject("completed", text).pipe(Effect.ignore)),
            Effect.catchCause((cause) =>
              (Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : inject("error", errorText(Cause.squash(cause))).pipe(Effect.ignore)
              ).pipe(Effect.andThen(Effect.failCause(cause))),
            ),
          ),
        })

        return {
          title: params.description,
          metadata: {
            ...metadata,
            jobId: info.id,
          },
          output: backgroundOutput(nextSession.id),
        }
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const text = yield* runTask()
            if (!(yield* ops.deliverable(childRunId, ctx.sessionID))) {
              return yield* Effect.fail(new Error("Sub-agent result is not deliverable to this session."))
            }
            const origin = yield* resultOrigin()
            return {
              title: params.description,
              // SEC-03: the processor raises this tool part to gate when the
              // child produced gate context; it never lowers a gate turn.
              metadata: origin === "gate" ? { ...metadata, origin } : metadata,
              output: output(nextSession.id, text),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit)) yield* cancel
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents ? DESCRIPTION + BACKGROUND_DESCRIPTION : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
