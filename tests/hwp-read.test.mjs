import test from "node:test"
import assert from "node:assert/strict"
import { parsePages, resolveDocPath, sortPageFiles, stripImages, MAX_PAGES } from "../upstream/.croakcode/plugins/hwp-read.js"

test("resolveDocPath handles Windows, relative and absolute paths", () => {
  assert.equal(resolveDocPath("C:\\Users\\me\\문서 1.hwp", "/work", "linux"), "/mnt/c/Users/me/문서 1.hwp")
  assert.equal(resolveDocPath('"d:/a/b.hwpx"', "/work", "linux"), "/mnt/d/a/b.hwpx")
  assert.equal(resolveDocPath("docs/a.hwp", "/work", "linux"), "/work/docs/a.hwp")
  assert.equal(resolveDocPath("/abs/a.hwp", "/work", "linux"), "/abs/a.hwp")
  assert.throws(() => resolveDocPath("  ", "/work", "linux"))
})

test("parsePages accepts summary, one page and ranges", () => {
  assert.deepEqual(parsePages("summary"), { summary: true })
  assert.deepEqual(parsePages(""), { summary: true })
  assert.deepEqual(parsePages("7"), { summary: false, from: 7, to: 7 })
  assert.deepEqual(parsePages("3 - 7"), { summary: false, from: 3, to: 7 })
})

test("parsePages rejects bad input and too many pages", () => {
  assert.throws(() => parsePages("0"))
  assert.throws(() => parsePages("7-3"))
  assert.throws(() => parsePages("1,2"))
  assert.throws(() => parsePages(`1-${MAX_PAGES + 1}`))
  assert.doesNotThrow(() => parsePages(`1-${MAX_PAGES}`))
})

test("stripImages keeps alt text only", () => {
  assert.equal(stripImages("앞 ![그림 1](a_assets/x.png) 뒤 ![](y.png)"), "앞 [이미지: 그림 1] 뒤 [이미지]")
})

test("sortPageFiles orders by page number, not by name", () => {
  assert.deepEqual(sortPageFiles(["d_010.md", "d_002.md", "d_001.md", "done", "d_assets"]), ["d_001.md", "d_002.md", "d_010.md"])
})

test("sortPageFiles treats a lone unnumbered export as page 1", () => {
  // rhwp export-markdown names a one-page document `<name>.md`.
  assert.deepEqual(sortPageFiles(["d.md", "done"]), ["d.md"])
  assert.deepEqual(sortPageFiles(["a.md", "b.md", "done"]), [])
})

import { classifyCli, convertArgs, hwpCli } from "../upstream/.croakcode/plugins/hwp-read.js"

test("classifyCli separates read, write and blocked commands", () => {
  assert.equal(classifyCli(["--help"]), "read")
  assert.equal(classifyCli(["edit", "replace-text", "--help"]), "read")
  assert.equal(classifyCli(["info", "a.hwp"]), "read")
  assert.equal(classifyCli(["edit", "replace-text", "a.hwp", "--find", "x", "--replace", "y", "--dry-run"]), "read")
  assert.equal(classifyCli(["edit", "replace-text", "a.hwp", "--find", "x", "--replace", "y"]), "write")
  assert.equal(classifyCli(["run", "plan.json"]), "write")
  assert.equal(classifyCli(["some-new-command", "a.hwp"]), "write")
  assert.equal(classifyCli(["mcp-serve"]), "blocked")
  assert.equal(classifyCli(["keygen"]), "blocked")
})

test("convertArgs maps only Windows drive paths", () => {
  assert.deepEqual(convertArgs(["info", "C:\\Users\\me\\a b.hwp", "--find", "C:"], "linux"), ["info", "/mnt/c/Users/me/a b.hwp", "--find", "C:"])
})

test("hwpCli asks before writing and never runs blocked commands", async () => {
  const asked = []
  const ctx = { directory: "/tmp", ask: async (req) => void asked.push(req) }
  await assert.rejects(() => hwpCli({ args: ["mcp-serve"] }, ctx), /실행하지 않는다/)
  await assert.rejects(() => hwpCli({ args: [] }, ctx), /비어 있다/)
  const denied = { directory: "/tmp", ask: async () => { throw new Error("rejected") } }
  await assert.rejects(() => hwpCli({ args: ["edit", "replace-text", "/nope.hwp", "--find", "a", "--replace", "b"] }, denied), /rejected/)
  const out = await hwpCli({ args: ["edit", "--help"] }, ctx)
  // The wrapper contract that does not depend on the binary: read commands run without
  // asking for permission and the result reports the command plus an exit code. With
  // the binary installed, hwp-read.rhwp.test.mjs checks the exit 0 path.
  assert.match(out, /^\$ rhwp edit --help$/m)
  assert.match(out, /^exit \d+$/m)
  assert.equal(asked.length, 0)
})
