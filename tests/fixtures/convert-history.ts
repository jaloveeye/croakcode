// Converts a MessageV2 history to model messages using the production function.
// Called from tests/phase3-context-e2e.test.mjs via `bun run`. Reads a JSON file
// from argv[2] and writes the resulting ModelMessage[] to stdout.
import { readFileSync } from "node:fs"
import { MessageV2 } from "../../upstream/packages/opencode/src/session/message-v2"

const input = JSON.parse(readFileSync(process.argv[2]!, "utf8"))

const model = {
  id: "qwen3.8-27b-nvfp4",
  providerID: "litellm-head",
  api: { id: "qwen3.8-27b-nvfp4", url: "http://127.0.0.1:0/v1", npm: "@ai-sdk/openai-compatible" },
  name: "Qwen test",
  capabilities: {
    temperature: true,
    attachment: false,
    reasoning: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128000, output: 8192 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
} as any

const messages = await MessageV2.toModelMessages(input, model)
process.stdout.write(JSON.stringify(messages))
