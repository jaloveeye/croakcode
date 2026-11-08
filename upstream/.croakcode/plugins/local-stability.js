export const server = async ({ client }) => {
  const warned = new Set();
  const loops = new Map();
  const users = new Map();
  const stable = (value) => JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  const keyFor = (tool, args) => {
    if (tool === "edit" && typeof args.oldString === "string" && args.oldString === args.newString)
      return "no-op-edit:" + stable({ filePath: args.filePath, oldString: args.oldString });
    if (["read", "grep", "glob"].includes(tool)) return tool + stable(args);
    if (tool !== "bash" || typeof args.command !== "string") return null;
    const command = args.command.trim();
    // Only simple searches; complex shell programs and mutations are excluded.
    if (/[\n|<>`]/.test(command) || /\$\(/.test(command)) return null;
    const segments = command.split(/;|&&/).map(s => s.trim()).filter(Boolean);
    if (!segments.some(s => /^(grep|rg)\s/.test(s)) ||
        !segments.every(s => /^(cd|grep|rg|echo)\s/.test(s))) return null;
    return "bash:" + command;
  };
  return {
    "tool.execute.before": async (input, output) => {
      const key = keyFor(input.tool, output.args);
      if (!key) { loops.delete(input.sessionID); return; }
      const previous = loops.get(input.sessionID);
      const count = previous?.key === key ? previous.count + 1 : 1;
      loops.delete(input.sessionID);
      loops.set(input.sessionID, { key, count });
      if (loops.size > 200) loops.delete(loops.keys().next().value);
      if (count <= 3) return;
      if (count === 4) {
        await client.tui.showToast({ body: { title: "반복 검색 차단", message: "동일한 읽기·검색을 3회 반복했습니다. 다음 작업으로 진행하도록 요청합니다.", variant: "warning", duration: 15000 } });
      } else {
        await client.tui.showToast({ body: { title: "반복 루프로 실행 중단", message: "차단 후에도 동일 호출이 반복되어 작업을 중단합니다. 완료 상태가 아닙니다.", variant: "error", duration: 15000 } });
        await client.session.abort({ path: { id: input.sessionID } });
      }
      throw new Error("Repeated non-progress tool call blocked: this identical call has already been attempted 3 times. Use its existing result and proceed to a different task or explain the remaining blocker. grep exit code 1 means no matches. Identical oldString and newString means there is no edit to make. Do not retry this identical call.");
    },
    event: async ({ event }) => {
      const info = event.properties?.info;
      if (event.type === "message.updated" && info?.role === "user" && users.get(info.sessionID) !== info.id) {
        users.delete(info.sessionID);
        users.set(info.sessionID, info.id);
        loops.delete(info.sessionID);
        if (users.size > 200) users.delete(users.keys().next().value);
      }
      if (event.type !== "message.updated" || info?.role !== "assistant" ||
          info.modelID !== "qwen3.8-27b-nvfp4" || info.finish !== "length" || warned.has(info.id)) return;
      warned.add(info.id);
      if (warned.size > 100) warned.delete(warned.values().next().value);
      await client.tui.showToast({ body: {
        title: "출력 한도로 작업 중단",
        message: "추론 또는 답변이 출력 예산을 소진했습니다. 작업 완료가 아닙니다. direct 모드로 전환하거나 범위를 나눠 계속하세요.",
        variant: "warning",
        duration: 15000,
      }});
    },
    "chat.params": async (input, output) => {
      if (input.model.providerID !== "litellm-head" || input.model.id !== "qwen3.8-27b-nvfp4") return;
      const direct = output.options?.chat_template_kwargs?.enable_thinking === false;
      output.temperature = direct ? 0.7 : 1.0;
      output.topP = direct ? 0.8 : 0.95;
    },
    "experimental.session.compacting": async (_input, output) => {
      output.prompt =
        "Create a continuation checkpoint, not a final answer to the user. Preserve the user's objective, constraints, document outline, terminology, required tables and formatting, exact file paths, completed changes, verification evidence, unresolved failures, and the next concrete steps. Distinguish finished work from planned work. Cite source paths and section names instead of copying full documents or tool logs. Preserve the path to any existing task-state file. Never invent progress. Do not include hidden reasoning or <think> text.";
    },
    "experimental.compaction.autocontinue": async (_input, output) => {
      output.enabled = true;
    },
  };
};

export default { id: "croak-local-stability", server };
