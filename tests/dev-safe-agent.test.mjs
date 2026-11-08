import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("dev-safe agent restricts bash/web/task", async () => {
  const md = await read("../upstream/.croakcode/agent/dev-safe.md");
  assert.match(md, /^---/m);
  assert.match(md, /name:\s*dev-safe/);
  assert.match(md, /mode:\s*primary/);
  for (const k of ["bash", "webfetch", "websearch", "task"]) assert.match(md, new RegExp(`${k}:\\s*deny`), k);
  assert.match(md, /edit:\s*ask/);
});

test("net-off/net-on/tool-status commands exist with descriptions", async () => {
  const off = await read("../upstream/.croakcode/command/net-off.md");
  const on = await read("../upstream/.croakcode/command/net-on.md");
  const st = await read("../upstream/.croakcode/command/tool-status.md");
  assert.match(off, /Disable internet tools/);
  assert.match(on, /Enable internet tools/);
  assert.match(st, /denies/);
  // Each command file must have frontmatter with a description and a body that
  // keeps the runtime policy from being overridden by tool calls.
  for (const md of [off, on, st]) {
    assert.match(md, /^---\n(?:.|\n)*?description:/);
    assert.match(md, /Do not call any tools/);
  }
});
