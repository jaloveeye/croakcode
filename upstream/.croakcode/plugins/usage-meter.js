// Records token usage and prefill/decode speed for every LLM request.
//
// Timing for one request (one agent step):
//   request  - `chat.headers` hook, right before opencode sends the HTTP request
//   first    - `step-start` part, which the AI SDK emits on the first streamed chunk
//   finish   - `step-finish` part, which carries the token usage
//
// prefill tok/s = uncached input tokens / (first - request)
// decode tok/s  = (output + reasoning tokens) / (finish - first)
//
// One JSON line per request goes to $CROAK_USAGE_FILE
// (default ~/.local/share/croak/usage.jsonl). Prompt text is never written.
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const usageFile = () =>
  process.env.CROAK_USAGE_FILE ||
  path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "croak", "usage.jsonl");

/** Shortest interval used for a speed; shorter ones are timer noise. */
const MIN_SPEED_MS = 50;
/** Fewest generated tokens for a decode speed; a 2-token reply measures latency, not decoding. */
const MIN_DECODE_TOKENS = 8;

const rate = (tokens, ms) => (ms >= MIN_SPEED_MS && tokens > 0 ? Math.round((tokens / ms) * 1000 * 10) / 10 : null);

/** Builds one usage record. Times are epoch milliseconds; any may be missing. */
export function buildRecord({ requestAt, firstAt, finishAt, tokens, sessionID, messageID, agent, providerID, modelID, finish }) {
  const t = {
    input: tokens?.input ?? 0,
    output: tokens?.output ?? 0,
    reasoning: tokens?.reasoning ?? 0,
    cacheRead: tokens?.cache?.read ?? 0,
    cacheWrite: tokens?.cache?.write ?? 0,
  };
  const ttftMs = requestAt && firstAt && firstAt >= requestAt ? firstAt - requestAt : null;
  const decodeMs = firstAt && finishAt && finishAt >= firstAt ? finishAt - firstAt : null;
  return {
    v: 1,
    ts: new Date(finishAt ?? Date.now()).toISOString(),
    sessionID,
    messageID,
    agent: agent ?? null,
    providerID: providerID ?? null,
    modelID: modelID ?? null,
    finish: finish ?? null,
    tokens: t,
    ttftMs,
    decodeMs,
    prefillTps: ttftMs === null ? null : rate(t.input, ttftMs),
    decodeTps:
      decodeMs === null || t.output + t.reasoning < MIN_DECODE_TOKENS ? null : rate(t.output + t.reasoning, decodeMs),
  };
}

/** Event-driven tracker; `now` and `write` are injectable for tests. */
export function createMeter({ now = () => Date.now(), write } = {}) {
  // One request is in flight per session at a time.
  const requests = new Map(); // sessionID -> { requestAt, agent, providerID, modelID }
  const firsts = new Map(); // messageID -> first chunk time of the current step
  const messages = new Map(); // messageID -> { agent, providerID, modelID }

  return {
    onRequest({ sessionID, agent, model }) {
      requests.set(sessionID, { requestAt: now(), agent, providerID: model?.providerID, modelID: model?.id });
    },
    async onEvent(event) {
      const props = event?.properties;
      if (event?.type === "message.updated" && props?.info?.role === "assistant") {
        const info = props.info;
        messages.set(info.id, { agent: info.agent, providerID: info.providerID, modelID: info.modelID });
        if (info.time?.completed) firsts.delete(info.id);
        return;
      }
      if (event?.type === "session.deleted") {
        requests.delete(props?.info?.id);
        return;
      }
      if (event?.type !== "message.part.updated") return;
      const part = props?.part;
      if (!part) return;
      if (part.type === "step-start") {
        if (!firsts.has(part.messageID)) firsts.set(part.messageID, now());
        return;
      }
      if (part.type !== "step-finish") return;
      const finishAt = now();
      const req = requests.get(part.sessionID);
      requests.delete(part.sessionID);
      const firstAt = firsts.get(part.messageID);
      firsts.delete(part.messageID);
      const msg = messages.get(part.messageID) ?? {};
      const record = buildRecord({
        requestAt: req?.requestAt,
        firstAt,
        finishAt,
        tokens: part.tokens,
        sessionID: part.sessionID,
        messageID: part.messageID,
        agent: msg.agent ?? req?.agent,
        providerID: msg.providerID ?? req?.providerID,
        modelID: msg.modelID ?? req?.modelID,
        finish: part.reason,
      });
      await write(record);
    },
  };
}

async function appendRecord(record) {
  const file = usageFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, JSON.stringify(record) + "\n", { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
}

export const server = async () => {
  const meter = createMeter({
    write: (record) => appendRecord(record).catch((error) => console.error("usage-meter: write failed:", error)),
  });
  return {
    "chat.headers": async (input) => {
      meter.onRequest({ sessionID: input.sessionID, agent: input.agent, model: input.model });
    },
    event: async ({ event }) => {
      await meter.onEvent(event);
    },
  };
};

// A default export makes opencode load only `server`. Without it every named
// export (the helpers above) is called as a plugin.
export default { id: "croak-usage-meter", server };
