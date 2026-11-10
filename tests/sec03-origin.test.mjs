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

  // Origin mapping lives in one helper next to the connection resolver.
  const mode = read("upstream/packages/opencode/src/session/llm/mode.ts")
  assert.match(mode, /export function originFor/, "origin must be derived by the shared originFor helper")

  // One connection snapshot per step: stamp, filter, and request share it.
  const prompt = read("upstream/packages/opencode/src/session/prompt.ts")
  assert.match(prompt, /origin: originFor\(connection\)/, "turn origin must derive from the step's connection snapshot")
  assert.match(
    prompt,
    /filterMessagesForModeParts\(msgs, connection\.mode\)/,
    "the direct filter must use the same snapshot as the stamp",
  )
  // The side question (Phase 5 Task 13) takes its own single snapshot: it
  // filters history and sends the request with it, and persists nothing, so
  // there is no part to stamp.
  assert.equal(
    (prompt.match(/connectionFor\(yield\* config\.get\(\)\)/g) ?? []).length,
    3,
    "only the loop step snapshot, the title request and the side question may read the connection mode",
  )
  const sideStart = prompt.indexOf('Effect.fn("SessionPrompt.side")')
  const side = prompt.slice(sideStart, prompt.indexOf('Effect.fn("SessionPrompt.command")', sideStart))
  assert.match(side, /filterMessagesForModeParts\(msgs, connection\.mode\)/, "the side question must filter with its snapshot")
  assert.match(side, /\n\s+connection,\n/, "the side question must send with the same snapshot")

  // Compaction filters its input and stamps its summary from one snapshot.
  const compaction = read("upstream/packages/opencode/src/session/compaction.ts")
  assert.match(compaction, /const connection = connectionFor\(cfg\)/, "compaction must snapshot the connection once")
  assert.match(compaction, /filterMessagesForModeParts\(/, "compaction input must pass the direct filter")
  assert.match(compaction, /origin: originFor\(connection\)/, "summary must inherit the snapshot provenance")

  // Sub-agent results take the provenance of the run that produced them.
  const task = read("upstream/packages/opencode/src/tool/task.ts")
  assert.match(task, /const launchConnection = connectionFor/, "sub-agent launch mode must be captured")
  assert.match(task, /containsGateContext/, "child history must decide whether the result is gate data")
  assert.match(task, /metadata: \{ origin \}/, "background sub-agent result injected as user text must be stamped")
  assert.doesNotMatch(
    task,
    /const origin[^\n]*connectionFor\(yield\* config\.get\(\)\)/,
    "the injected result must not be classified by the mode at injection time",
  )

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

// SEC-03 follow-up: the runtime persists content-free structural parts
// (step-start/step-finish/snapshot/patch) that have no `metadata` field and so
// can never carry a stamp. They must not make a direct-produced assistant
// message look unprovable, but every other unstamped type stays fail-closed.
test("structural parts do not hide direct history; other unstamped parts stay protected", async () => {
  const { STRUCTURAL_PART_TYPES } = await import(lib)
  assert.deepEqual([...STRUCTURAL_PART_TYPES].sort(), ["patch", "snapshot", "step-finish", "step-start"])
  for (const type of STRUCTURAL_PART_TYPES) assert.equal(isProtectedAssistantPart({ type }), false, type)
  for (const type of ["text", "reasoning", "tool", "file", "retry", "agent", "subtask", "unknown-type"])
    assert.equal(isProtectedAssistantPart({ type }), true, `${type} without origin must be protected`)
  // A structural part cannot launder a gate-stamped sibling.
  const gateTurn = {
    info: { role: "assistant" },
    parts: [{ type: "step-start" }, { type: "text", text: "secret", metadata: { origin: "gate" } }, { type: "step-finish" }],
  }
  const directTurn = {
    info: { role: "assistant" },
    parts: [{ type: "step-start" }, { type: "text", text: "ok", metadata: { origin: "user" } }, { type: "step-finish" }],
  }
  assert.deepEqual(filterMessagesForModeParts([gateTurn, directTurn], "direct"), [directTurn])
})

test("containsGateContext classifies a producing history fail-closed", async () => {
  const { containsGateContext } = await import(lib)
  const user = { info: { role: "user" }, parts: [{ type: "text", text: "q" }] }
  const direct = { info: { role: "assistant" }, parts: [{ type: "step-start" }, { type: "text", text: "a", metadata: { origin: "user" } }] }
  const gate = { info: { role: "assistant" }, parts: [{ type: "text", text: "s", metadata: { origin: "gate" } }] }
  const legacy = { info: { role: "assistant" }, parts: [{ type: "text", text: "old" }] }
  const injected = { info: { role: "user" }, parts: [{ type: "text", synthetic: true, text: "r", metadata: { origin: "gate" } }] }
  assert.equal(containsGateContext([]), false)
  assert.equal(containsGateContext([user, direct]), false)
  assert.equal(containsGateContext([user, gate]), true)
  assert.equal(containsGateContext([user, legacy]), true, "unstamped assistant content is unprovable")
  assert.equal(containsGateContext([injected]), true, "nested gate sub-agent result taints the parent run")
})
