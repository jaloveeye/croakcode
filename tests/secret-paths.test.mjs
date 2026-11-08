import assert from "node:assert/strict";
import test from "node:test";
import { commandPaths, deniedCall, deniedPath, filterOutput, server } from "../upstream/.croakcode/plugins/secret-paths.js";

test("blocked folders and files", () => {
  for (const p of [
    "/home/user/.ssh/id_rsa",
    "~/.ssh/config",
    ".aws/credentials",
    "/root/.gnupg/pubring.kbx",
    "/home/herace/.config/croak/session.json",
    ".env",
    "app/prod.env",
    "certs/server.pem",
    "tls/server.key",
    "id_ed25519",
    "C:\\Users\\kim\\.ssh\\known_hosts",
  ]) {
    assert.ok(deniedPath(p), p);
  }
});

test("lookalikes stay readable", () => {
  for (const p of [".env.example", "src/environment.ts", "docs/ssh.md", "monkey.txt", ".config/opencode/opencode.jsonc", "keys.md", "README.md", ""]) {
    assert.equal(deniedPath(p), null, p);
  }
});

test("tool calls", () => {
  assert.ok(deniedCall("read", { filePath: "/home/u/.ssh/id_rsa" }));
  assert.ok(deniedCall("grep", { pattern: "password", path: ".", include: "*.env" }));
  assert.ok(deniedCall("glob", { pattern: "**/*.pem" }));
  assert.ok(deniedCall("bash", { command: "cat ~/.aws/credentials | head" }));
  assert.ok(deniedCall("bash", { command: "cp .env /tmp/x" }));
  assert.equal(deniedCall("bash", { command: "git status && ls src" }), null);
  assert.equal(deniedCall("read", { filePath: "src/main.ts" }), null);
  assert.deepEqual(commandPaths("ssh -i ~/.ssh/key host"), ["ssh", "~/.ssh/key", "host"]);
});

test("output filter drops blocked lines only", () => {
  const out = "src/a.ts:3: password = os.environ\n.env:1: DB_PASSWORD=x\nconfig/prod.env:2: KEY=y\nREADME.md:9: hello";
  const { text, removed } = filterOutput(out);
  assert.equal(removed, 2);
  assert.ok(text.includes("src/a.ts:3"));
  assert.ok(text.includes("README.md:9"));
  assert.ok(!text.includes("DB_PASSWORD"));
  assert.ok(text.includes("줄 2개를 뺐다"));
});

test("hooks", async () => {
  const hooks = await server();
  await assert.rejects(hooks["tool.execute.before"]({ tool: "read" }, { args: { filePath: "/x/.ssh/id_rsa" } }), /읽을 수 없다/);
  await hooks["tool.execute.before"]({ tool: "read" }, { args: { filePath: "src/x.ts" } });
  const output = { output: ".env:1: SECRET=1\nok.ts:1: fine" };
  await hooks["tool.execute.after"]({ tool: "grep" }, output);
  assert.ok(!output.output.includes("SECRET"));
});
