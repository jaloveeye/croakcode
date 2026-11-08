import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NET_TOOLS,
  createPolicyReader,
  deniedFor,
  isDenied,
  normalizePolicy,
  readPolicy,
  writePolicy,
} from "../upstream/.croakcode/plugins/lib/policy-state.js";
import { server } from "../upstream/.croakcode/plugins/tool-policy.js";

const tempFile = async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "croak-tool-policy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "tool-policy.json");
};

test("normalizePolicy keeps only known fields and dedupes", () => {
  assert.deepEqual(normalizePolicy(undefined), { deny: [], sessions: {} });
  assert.deepEqual(
    normalizePolicy({ deny: ["websearch", " websearch ", "", 42, "webfetch"], sessions: { s1: ["bash"], s2: [] }, extra: true }),
    { deny: ["websearch", "webfetch"], sessions: { s1: ["bash"] } },
  );
});

test("deniedFor merges global and session rules", () => {
  const policy = { deny: ["websearch"], sessions: { s1: ["bash"], s2: ["webfetch"] } };
  assert.deepEqual([...deniedFor(policy, "s1")].sort(), ["bash", "websearch"]);
  assert.deepEqual([...deniedFor(policy, "s3")].sort(), ["websearch"]);
  assert.deepEqual([...deniedFor(policy, undefined)].sort(), ["websearch"]);
});

test("isDenied supports exact and wildcard rules", () => {
  assert.equal(isDenied({ deny: ["websearch"] }, "s1", "websearch"), true);
  assert.equal(isDenied({ deny: ["websearch"] }, "s1", "webfetch"), false);
  assert.equal(isDenied({ deny: ["rhwp_*"] }, "s1", "rhwp_replace_text"), true);
  assert.equal(isDenied({ deny: ["*"] }, "s1", "read"), true);
});

test("writePolicy and readPolicy roundtrip atomically", async (t) => {
  const file = await tempFile(t);
  const policy = await writePolicy({ deny: NET_TOOLS, sessions: { s1: ["bash"] } }, file);
  assert.deepEqual(policy, { deny: ["websearch", "webfetch"], sessions: { s1: ["bash"] } });
  assert.deepEqual(await readPolicy(file), policy);
  const body = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(body.deny, ["websearch", "webfetch"]);
  assert.match(body.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("createPolicyReader refreshes after the file changes", async (t) => {
  const file = await tempFile(t);
  const reader = createPolicyReader(file);
  assert.deepEqual(await reader(), { deny: [], sessions: {} });
  await writePolicy({ deny: ["websearch"] }, file);
  assert.deepEqual(await reader(), { deny: ["websearch"], sessions: {} });
  await writePolicy({ deny: [] }, file);
  assert.deepEqual(await reader(), { deny: [], sessions: {} });
});

test("plugin blocks denied tools and allows the rest", async (t) => {
  const file = await tempFile(t);
  process.env.CROAK_TOOL_POLICY_FILE = file;
  t.after(() => delete process.env.CROAK_TOOL_POLICY_FILE);
  const plugin = await server();
  const output = { parts: [{ type: "text", text: "template" }] };

  await plugin["command.execute.before"]({ command: "net-off", sessionID: "s1" }, output);
  assert.deepEqual((await readPolicy(file)).deny, ["websearch", "webfetch"]);
  assert.match(output.parts[0].text, /disabled/);

  await assert.rejects(plugin["tool.execute.before"]({ tool: "websearch", sessionID: "s1" }), /disabled by the croak tool policy/);
  await assert.rejects(plugin["tool.execute.before"]({ tool: "webfetch", sessionID: "s1" }), /disabled by the croak tool policy/);
  await plugin["tool.execute.before"]({ tool: "read", sessionID: "s1" });

  await plugin["command.execute.before"]({ command: "net-on", sessionID: "s1" }, output);
  assert.deepEqual((await readPolicy(file)).deny, []);
  await plugin["tool.execute.before"]({ tool: "websearch", sessionID: "s1" });
});

test("plugin respects session-specific rules and reports status", async (t) => {
  const file = await tempFile(t);
  process.env.CROAK_TOOL_POLICY_FILE = file;
  t.after(() => delete process.env.CROAK_TOOL_POLICY_FILE);
  await writePolicy({ deny: [], sessions: { s2: ["bash"] } }, file);
  const plugin = await server();
  const output = { parts: [{ type: "text", text: "template" }] };

  await assert.rejects(plugin["tool.execute.before"]({ tool: "bash", sessionID: "s2" }), /disabled/);
  await plugin["tool.execute.before"]({ tool: "bash", sessionID: "s1" });

  await plugin["command.execute.before"]({ command: "tool-status", sessionID: "s2" }, output);
  assert.match(output.parts[0].text, /bash/);
  assert.doesNotMatch(output.parts[0].text, /none/);
});

test("/net-on resets a broken policy file and keeps a copy", async (t) => {
  const file = await tempFile(t);
  await writeFile(file, "{broken", "utf8");
  process.env.CROAK_TOOL_POLICY_FILE = file;
  t.after(() => delete process.env.CROAK_TOOL_POLICY_FILE);
  const hooks = await server();
  await assert.rejects(hooks["tool.execute.before"]({ tool: "read", sessionID: "s1" }), /unreadable/);
  const status = { parts: [] };
  await hooks["command.execute.before"]({ command: "tool-status", sessionID: "s1" }, status);
  assert.match(status.parts[0].text, /unreadable/);
  await hooks["command.execute.before"]({ command: "net-on", sessionID: "s1" }, { parts: [] });
  assert.deepEqual(await readPolicy(file), { deny: [], sessions: {} });
  assert.equal(await readFile(`${file}.broken`, "utf8"), "{broken");
  await hooks["tool.execute.before"]({ tool: "read", sessionID: "s1" });
});
