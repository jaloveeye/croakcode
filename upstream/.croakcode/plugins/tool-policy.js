// Runtime tool policy. Slash commands /net-off, /net-on, and /tool-status are
// handled in `command.execute.before`; every tool execution checks the policy
// file first and throws before the tool runs when it is denied.
//
// The policy is read from $CROAK_TOOL_POLICY_FILE, defaulting to
// ~/.local/share/croak/tool-policy.json. The file is written by the
// slash command handler in this plugin and can be edited by hand.
import { rename } from "node:fs/promises";
import {
  NET_TOOLS,
  createPolicyReader,
  deniedFor,
  isDenied,
  policyFile,
  readPolicy,
  writePolicy,
} from "./lib/policy-state.js";

const statusLine = (tools) => (tools.length ? tools.join(", ") : "none");

// The command's text stays in the conversation. An unscoped "Do not call any
// tools. Reply with exactly: ..." made Qwen answer every later message with
// the same line (found in the 2026-11-10 full test), so the notice says it
// applies to this reply only.
const notice = (event, reply) =>
  `[croak notice, for this reply only] ${event} Do not call tools for this reply; answer only with: ${reply}\n` +
  "This notice does not apply to later messages. Handle them as usual with the tools that remain available.";

export const server = async () => {
  const load = createPolicyReader();

  // A broken file must not stop /net-on and /net-off from resetting it: keep
  // the broken copy next to it and start from an empty policy.
  const update = async (deny) => {
    let current;
    try {
      current = await readPolicy();
    } catch {
      await rename(policyFile(), `${policyFile()}.broken`).catch(() => {});
      current = undefined;
    }
    await writePolicy({ ...current, deny });
  };

  return {
    "command.execute.before": async (input, output) => {
      if (input.command === "net-off") {
        await update(NET_TOOLS);
        output.parts.splice(0, output.parts.length, {
          type: "text",
          text: notice("The user ran /net-off: websearch and webfetch are disabled in every session until /net-on.", "인터넷 도구를 껐습니다."),
        });
        return;
      }

      if (input.command === "net-on") {
        await update([]);
        output.parts.splice(0, output.parts.length, {
          type: "text",
          text: notice("The user ran /net-on: websearch and webfetch are enabled again.", "인터넷 도구를 켰습니다."),
        });
        return;
      }

      if (input.command === "tool-status") {
        let status;
        try {
          status = `Denied tools: ${statusLine([...deniedFor(await readPolicy(), input.sessionID)].sort())}.`;
        } catch {
          status = `The policy file ${policyFile()} is unreadable, so every tool is blocked. Run /net-on to reset it.`;
        }
        output.parts.splice(0, output.parts.length, {
          type: "text",
          text: notice("The user ran /tool-status.", status),
        });
      }
    },

    "tool.execute.before": async (input) => {
      let policy;
      try {
        policy = await load();
      } catch (error) {
        throw new Error(
          `Tool policy file is unreadable (${policyFile()}): ${error instanceof Error ? error.message : String(error)}. ` +
            "Fix the file or run /net-on to reset it.",
        );
      }
      if (!isDenied(policy, input.sessionID, input.tool)) return;
      throw new Error(
        `Tool "${input.tool}" is disabled by the croak tool policy. ` +
          "Edit the policy file to allow it, or run /net-on to clear the internet block.",
      );
    },
  };
};
export default { id: "croak-tool-policy", server };
