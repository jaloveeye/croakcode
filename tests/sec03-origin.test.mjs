import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..")
const lib = path.join(root, "upstream/.croakcode/plugins/lib/connection.js")
const { markOrigin, isGateOnlyPart, isUntrustedOrigin, isProtectedAssistantPart, filterMessagesForModeParts } =
  await import(lib)

// SEC-03: the runtime must stamp provenance on every assistant part it persists,
// otherwise the direct-mode filter cannot tell gate-produced context apart from
// ordinary provider output. These tests pin the stamping helper and the
// fail-closed filter rule.

test("markOrigin stamps trusted provenance and cannot be overwritten by untrusted metadata", () => {
  const part = { type: "text", text: "hi", metadata: { providerExecuted: true } }
  const marked = markOrigin(part, "gate")
  assert.equal(marked.metadata.origin, "gate")
  assert.equal(marked.metadata.providerExecuted, true, "existing metadata must be preserved")

  // A provider (or model) claiming a different origin must not win.
  const spoof = markOrigin({ type: "text", text: "x", metadata: { origin: "user" } }, "gate")
  assert.equal(spoof.metadata.origin, "gate", "trusted stamp wins over pre-existing origin")

  // Stamping is idempotent.
  const twice = markOrigin(marked, "gate")
  assert.equal(twice.metadata.origin, "gate")
  assert.equal(twice.metadata.providerExecuted, true)
})

test("markOrigin keeps user-authored parts trusted and does not tag them gate", () => {
  const userPart = { type: "text", text: "my own words" }
  const marked = markOrigin(userPart, "user")
  assert.equal(marked.metadata.origin, "user")
  assert.equal(isGateOnlyPart(marked), false)
})

test("isUntrustedOrigin rejects unknown/garbage origin values", () => {
  assert.equal(isUntrustedOrigin({ metadata: { origin: "gate" } }), false)
  assert.equal(isUntrustedOrigin({ metadata: { origin: "user" } }), false)
  assert.equal(isUntrustedOrigin({ metadata: { origin: "GATE" } }), true)
  assert.equal(isUntrustedOrigin({ metadata: { origin: "gate-ish" } }), true)
  assert.equal(isUntrustedOrigin({ metadata: {} }), true)
  assert.equal(isUntrustedOrigin({ metadata: undefined }), true)
})

test("isProtectedAssistantPart: gate-origin and untrusted origin are protected; user-origin text is not", () => {
  assert.equal(isProtectedAssistantPart({ type: "text", metadata: { origin: "gate" } }), true)
  assert.equal(isProtectedAssistantPart({ type: "text", metadata: {} }), true)
  assert.equal(isProtectedAssistantPart({ type: "text", metadata: { origin: "bogus" } }), true)
  assert.equal(isProtectedAssistantPart({ type: "text", metadata: { origin: "user" } }), false)
  assert.equal(isProtectedAssistantPart({ type: "text", metadata: { origin: "user" }, text: "mine" }), false)
})

test("fail-closed: assistant text with NO origin stamp is dropped in direct mode", () => {
  const msgs = [
    { info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "hi", metadata: { origin: "user" } }] },
    // legacy / unstamped assistant text — must be treated as protected (fail-closed)
    { info: { role: "assistant", id: "a1" }, parts: [{ type: "text", text: "unstamped" }] },
    // explicit trusted user-origin assistant text is kept
    { info: { role: "assistant", id: "a2" }, parts: [{ type: "text", text: "kept", metadata: { origin: "user" } }] },
    // gate-origin assistant text is dropped
    { info: { role: "assistant", id: "a3" }, parts: [{ type: "text", text: "secret", metadata: { origin: "gate" } }] },
  ]
  const direct = filterMessagesForModeParts(msgs, "direct")
  assert.deepEqual(direct.map((m) => m.info.id), ["u1", "a2"])
  assert.equal(filterMessagesForModeParts(msgs, "gate"), msgs)
})

test("user turns: genuine input kept, but a gate-stamped synthetic user part is withheld in direct mode", () => {
  const msgs = [
    // genuine user input, unstamped — must never be removed
    { info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "mine" }] },
    // genuine user input explicitly user-stamped — kept
    { info: { role: "user", id: "u2" }, parts: [{ type: "text", text: "also mine", metadata: { origin: "user" } }] },
    // synthetic user turn injecting gate sub-agent output — must be withheld
    { info: { role: "user", id: "u3" }, parts: [{ type: "text", text: "subagent secret", metadata: { origin: "gate" } }] },
  ]
  const direct = filterMessagesForModeParts(msgs, "direct")
  assert.deepEqual(direct.map((m) => m.info.id), ["u1", "u2"])
})

test("production runtime stamps provenance on persisted parts (source check, no duplicate logic)", () => {
  const read = (p) => readFileSync(path.join(root, p), "utf8")
  const processor = read("upstream/packages/opencode/src/session/processor.ts")
  assert.match(
    processor,
    /markOrigin|originFor|provenanceFor|ORIGIN_/,
    "processor.ts must stamp part provenance; without it the direct filter cannot protect gate context",
  )
  // Text + reasoning parts stamped at start and re-stamped on every delta/end
  // so a provider-supplied metadata object can never erase the trusted origin.
  assert.match(processor, /origin: ctx\.origin/, "text/reasoning parts must carry ctx.origin")
  // Tool parts carry model-adjacent content; they must be attributable too.
  assert.match(processor, /const withOrigin\b/, "tool-part metadata must be stamped via a helper")
  assert.match(processor, /withOrigin\(/, "tool-part writes must go through withOrigin")
  // The turn origin is decided by the runtime from connection mode, not by the model.
  assert.match(processor, /origin:\s*input\.origin/, "processor must adopt the caller-supplied turn origin")

  const prompt = read("upstream/packages/opencode/src/session/prompt.ts")
  assert.match(prompt, /turnOrigin/, "prompt loop must compute the turn origin from connection mode")
  assert.match(
    prompt,
    /connectionFor\(yield\* config\.get\(\)\)\.mode === "gate" \? "gate" : "user"/,
    "turn origin must derive from the effective connection mode (trusted runtime signal)",
  )

  const compaction = read("upstream/packages/opencode/src/session/compaction.ts")
  assert.match(
    compaction,
    /origin:\s*connectionFor\(yield\* config\.get\(\)\)\.mode === "gate" \? "gate" : "user"/,
    "compaction summaries must inherit the turn provenance, not default to gate",
  )

  const task = read("upstream/packages/opencode/src/tool/task.ts")
  assert.match(task, /metadata: \{ origin \}/, "background sub-agent result injected as user text must be stamped")

  const messageV2 = read("upstream/packages/opencode/src/session/message-v2.ts")
  assert.match(
    messageV2,
    /origin: __/,
    "providerMeta must strip runtime origin so it never reaches the provider request body",
  )
  // Text and reasoning parts persist their provenance in `metadata`; the model
  // conversion must route those through providerMeta too, otherwise the origin
  // stamp leaks into the provider payload (and corrupts replay matching).
  assert.doesNotMatch(
    messageV2,
    /providerMetadata: part\.metadata\b(?!\))/,
    "text/reasoning provider metadata must go through providerMeta (no raw part.metadata)",
  )
  assert.match(
    messageV2,
    /providerMetadata: providerMeta\(part\.metadata\)/,
    "reasoning provider metadata must be origin-stripped",
  )
})
