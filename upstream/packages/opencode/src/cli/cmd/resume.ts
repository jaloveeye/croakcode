import { cmd } from "@/cli/cmd/cmd"
import { withNetworkOptions } from "@/cli/network"
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

export const ResumeCommand = cmd({
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
      .conflicts("last", "session"),
  handler: async (args) => {
    await runTui(resolveResumeArgs(args))
  },
})
