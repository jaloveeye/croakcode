import path from "path"
import { EOL } from "os"
import { Effect } from "effect"
import { effectCmd } from "@/cli/effect-cmd"
import { withNetworkOptions } from "@/cli/network"
import { Session } from "@/session/session"
import { InstanceState } from "@/effect/instance-state"
import { Locale } from "@/util/locale"
import { runTui } from "./tui/thread"

export function resolveResumeArgs<T extends { last?: boolean; session?: string }>(args: T) {
  const selectSession = !args.last && !args.session
  return {
    ...args,
    continue: args.last === true,
    "select-session": selectSession,
    selectSession,
  }
}

/** Default number of sessions `resume --list` prints. */
const LIST_COUNT = 20

export const ResumeCommand = effectCmd({
  command: "resume [project]",
  describe: "resume a croakcode session",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start croakcode in",
      })
      .option("last", {
        alias: ["l"],
        type: "boolean",
        describe: "resume the most recently updated session",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to resume",
      })
      .option("list", {
        type: "boolean",
        describe: "print this folder's sessions and exit",
      })
      .option("max-count", {
        alias: ["n"],
        type: "number",
        describe: `with --list, how many sessions to print (default ${LIST_COUNT})`,
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when resuming (use with --last or --session)",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("dangerously-skip-permissions", {
        type: "boolean",
        describe: "start with automatic permission approval enabled (dangerous!)",
        default: false,
      })
      .conflicts("last", "session")
      .conflicts("list", ["last", "session"]),
  // Only --list reads sessions here; the TUI loads its own project.
  instance: (args) => args.list === true,
  directory: (args) => path.resolve(args.project ?? process.cwd()),
  handler: Effect.fn("Cli.resume")(function* (args) {
    if (!args.list) {
      yield* Effect.promise(async () => runTui(resolveResumeArgs(args) as never))
      return
    }
    // The same filter as the TUI's session list: this folder within the project.
    // Folders outside git all share one project, so without it --list showed
    // sessions of every such folder.
    const ctx = yield* InstanceState.context
    const folder = path.relative(path.resolve(ctx.worktree), ctx.directory).replaceAll("\\", "/")
    const sessions = yield* Session.Service.use((svc) =>
      svc.list({ roots: true, path: folder, limit: args["max-count"] ?? LIST_COUNT }),
    )
    console.log(formatSessionList(sessions))
  }),
})

/** The table `resume --list` prints. The title goes last: Korean titles are double width. */
export function formatSessionList(sessions: readonly { id: string; title: string; time: { updated: number } }[]) {
  if (sessions.length === 0) return "이 폴더에는 세션이 없습니다."
  const width = Math.max(...sessions.map((s) => s.id.length))
  const times = sessions.map((s) => Locale.todayTimeOrDateTime(s.time.updated))
  const timeWidth = Math.max(11, ...times.map((t) => t.length))
  return [
    // "마지막 사용" is 6 characters but 11 columns wide.
    `${"ID".padEnd(width)}  마지막 사용${" ".repeat(Math.max(0, timeWidth - 11))}  제목`,
    ...sessions.map((s, i) => `${s.id.padEnd(width)}  ${times[i].padEnd(timeWidth)}  ${s.title}`),
    "",
    "이어서 열기: croakcode resume -s <ID>   가장 최근 세션: croakcode resume --last",
  ].join(EOL)
}
