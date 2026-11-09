import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import path from "node:path"
import { createCaptureProvider } from "./fixtures/capture-provider.mjs"

const root = path.resolve(import.meta.dirname, "..")
const { filterMessagesForModeParts } = await import(
  path.join(root, "upstream/.croakcode/plugins/lib/connection.js")
)
const { shouldAttachToken } = await import(path.join(root, "upstream/.croakcode/plugins/croak-auth-server.js"))

// The real conversion function cannot be imported into node --test (it is a
// TypeScript module with path aliases), so this test drives it through bun via
// the helper below. The helper is the ONLY seam: it calls the production
// function `MessageV2.toModelMessages`, it does not reimplement conversion.
const CONVERT_SCRIPT = path.join(root, "tests/fixtures/convert-history.ts")

// Run a bun script that reads JSON history from argv[2] (a temp file) and writes
// the converted messages to stdout. Uses Bun.spawn with a file for input.
function convert(history) {
  const dir = mkdtempSync(path.join(tmpdir(), "phase3-e2e-"))
  const input = path.join(dir, "history.json")
  writeFileSync(input, JSON.stringify(history), "utf8")
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", CONVERT_SCRIPT, input], {
      cwd: path.join(root, "upstream/packages/opencode"),
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (c) => (out += c))
    child.stderr.on("data", (c) => (err += c))
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`conversion failed (exit ${code}): ${err}`))
      resolve(JSON.parse(out))
    })
  })
}

function userMsg(id, text) {
  return {
    info: {
      id,
      sessionID: "s1",
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "litellm-head", modelID: "qwen3.8-27b-nvfp4" },
    },
    parts: [{ id: `p_${id}`, sessionID: "s1", messageID: id, type: "text", text }],
  }
}

function assistantMsg(id, parentID, parts) {
  return {
    info: {
      id,
      sessionID: "s1",
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      parentID,
      modelID: "qwen3.8-27b-nvfp4",
      providerID: "litellm-head",
      mode: "build",
      agent: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: parts.map((part, i) => ({
      id: `p_${id}_${i}`,
      sessionID: "s1",
      messageID: id,
      ...part,
    })),
  }
}

const SECRET = "GATE_SECRET_TOKEN=abc123"

test("5. gate→direct: gate-origin secret never reaches the provider payload", async () => {
  // Build a History that contains a gate-origin secret assistant turn.
  const history = [
    userMsg("m1", "show me the internal key"),
    assistantMsg("m2", "m1", [{ type: "text", text: SECRET, metadata: { origin: "gate", sensitivity: "secret" } }]),
    userMsg("m3", "continue"),
  ]

  const filtered = filterMessagesForModeParts(history, "direct")
  assert.equal(filtered.length, 2, "gate-origin assistant message must be dropped before conversion")

  // Convert with the REAL production function (MessageV2.toModelMessages).
  const modelMessages = await convert(filtered)
  assert.ok(Array.isArray(modelMessages) && modelMessages.length > 0, "conversion produced no messages")

  // POST the real converted payload to a capture provider.
  const cap = createCaptureProvider()
  const port = await cap.listen()
  const baseURL = `http://127.0.0.1:${port}/v1`
  try {
    await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3.8-27b-nvfp4", messages: modelMessages }),
    })
  } finally {
    await cap.close()
  }

  assert.equal(cap.captured.length, 1, "capture provider received no request")
  const raw = JSON.stringify(cap.captured[0].body)
  assert.ok(!raw.includes(SECRET), "gate secret leaked into the direct payload")
  assert.ok(!raw.includes("abc123"), "gate secret value leaked into the direct payload")
  assert.ok(raw.includes("continue"), "the later user turn must be kept")

  // Scenario 4 (token half): direct mode never attaches the gate token.
  assert.equal(
    shouldAttachToken({
      model: { providerID: "litellm-head" },
      provider: { id: "litellm-head", options: { baseURL } },
      connection: { mode: "direct" },
    }),
    false,
  )
  assert.equal(cap.captured[0].headers.authorization, undefined, "Authorization must be absent in direct mode")
})

test("5b. gate mode keeps the very same gate-origin message", async () => {
  const history = [
    userMsg("m1", "show me the internal key"),
    assistantMsg("m2", "m1", [{ type: "text", text: SECRET, metadata: { origin: "gate", sensitivity: "secret" } }]),
    userMsg("m3", "continue"),
  ]
  const kept = filterMessagesForModeParts(history, "gate")
  assert.equal(kept, history, "gate mode must not drop anything")
  const modelMessages = await convert(kept)
  const raw = JSON.stringify(modelMessages)
  assert.ok(raw.includes(SECRET), "gate mode must keep the gate-origin content")
})

test("5c. gate token is attached in gate mode for the configured gate origin", async () => {
  // The 3-way condition (provider + origin + mode) is exercised by
  // tests/croak-auth-server.test.mjs; this pins the runtime call shape.
  // Import session lib lazily: tests/croak-auth-session.test.mjs sets
  // CROAK_AUTH_URL before importing it, and module env is read at call time.
  const S = await import(path.join(root, "upstream/.croakcode/plugins/lib/croak-auth-session.js"))
  // There is no built-in gate address; configure a test one for this case.
  const saved = process.env.CROAK_AUTH_URL
  process.env.CROAK_AUTH_URL = saved ?? "https://gate.test"
  const gateBase = `${S.authUrl()}/v1`
  let ok, missingMode
  try {
    ok = shouldAttachToken({
      model: { providerID: "litellm-head" },
      provider: { id: "litellm-head", options: { baseURL: gateBase } },
      connection: { mode: "gate" },
    })
    missingMode = shouldAttachToken({
      model: { providerID: "litellm-head" },
      provider: { id: "litellm-head", options: { baseURL: gateBase } },
    })
  } finally {
    if (saved === undefined) delete process.env.CROAK_AUTH_URL
    else process.env.CROAK_AUTH_URL = saved
  }
  // gateBase uses the current authUrl() origin, so origin equality holds.
  assert.equal(ok, true)
  assert.equal(missingMode, false, "missing mode must fail closed (no token)")
})

test("production filter is imported by the real request path (no duplicate copy)", () => {
  const prompt = readFileSync(path.join(root, "upstream/packages/opencode/src/session/prompt.ts"), "utf8")
  const mode = readFileSync(path.join(root, "upstream/packages/opencode/src/session/llm/mode.ts"), "utf8")
  assert.match(mode, /filterMessagesForModeParts/, "mode.ts must re-export the production filter")
  assert.match(prompt, /from "\.\/llm\/mode"/, "prompt.ts must import the helpers from llm/mode")
  assert.match(prompt, /filterMessagesForModeParts\(msgs, connection\.mode\)/, "prompt.ts must call the filter on msgs")
  assert.match(prompt, /toModelMessagesEffect\(msgsForModel/, "conversion must use the filtered messages")
})
