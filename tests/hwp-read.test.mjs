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

import { classifyCli, convertArgs, hwpCli, outputPaths } from "../upstream/.croakcode/plugins/hwp-read.js"

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

test("outputPaths finds every output option form", () => {
  assert.deepEqual(outputPaths(["export-structure", "a.hwp", "-o", "s.json"]), ["s.json"])
  assert.deepEqual(outputPaths(["export-text", "a.hwp", "--output=out"]), ["out"])
  assert.deepEqual(outputPaths(["x", "--out", "a", "--output-dir", "b", "-oc.hwp"]), ["a", "b", "c.hwp"])
  assert.deepEqual(outputPaths(["info", "a.hwp", "--occurrence", "2"]), [])
})

test("classifyCli treats any output option as a write", () => {
  // export-text always writes (to output/ when -o is missing).
  assert.equal(classifyCli(["export-text", "a.hwp"]), "write")
  assert.equal(classifyCli(["export-structure", "a.hwp"]), "read")
  assert.equal(classifyCli(["export-structure", "a.hwp", "-o", "s.json"]), "write")
  assert.equal(classifyCli(["edit", "replace-text", "a.hwp", "--find", "x", "--replace", "y", "--dry-run", "-o", "b.hwp"]), "write")
})

test("hwpCli refuses an output on a key or secret path before asking", async () => {
  const asked = []
  const ctx = { directory: "/home/u/work", ask: async (req) => void asked.push(req) }
  const cases = [
    ["edit", "replace-text", "a.hwp", "--find", "a", "--replace", "b", "-o", "/home/u/.ssh/authorized_keys"],
    ["export-structure", "a.hwp", "--out=../.env"],
    ["export-text", "a.hwp", "-o", "C:\\Users\\u\\.aws\\out"],
    ["edit", "replace-text", "a.hwp", "--find", "a", "--replace", "b", "-oserver.key"],
  ]
  for (const args of cases) await assert.rejects(() => hwpCli({ args }, ctx), /비밀 파일 경로/, args.join(" "))
  assert.equal(asked.length, 0)
  const refused = { directory: "/home/u/work", ask: async (req) => { asked.push(req); throw new Error("rejected") } }
  await assert.rejects(() => hwpCli({ args: ["export-structure", "a.hwp", "-o", "s.json"] }, refused), /rejected/)
  assert.deepEqual(asked[0].metadata.outputs, ["/home/u/work/s.json"])
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

import { hwpMemo, memoOutputPath, planMemo, DEFAULT_MEMO_AUTHOR } from "../upstream/.croakcode/plugins/hwp-read.js"

test("memoOutputPath writes next to the input, never over it", () => {
  assert.equal(memoOutputPath("/w/보고서.hwp"), "/w/보고서_memo.hwp")
  assert.equal(memoOutputPath("/w/a.b.hwpx"), "/w/a.b_memo.hwpx")
})

test("planMemo maps actions to rhwp session tools and validates input", () => {
  assert.deepEqual(planMemo("list", {}, "/w/a.hwp", "/w"), { write: false, name: "hwp_doc_memos", args: {} })
  const create = planMemo("create", { section: 0, para: 2, start: 1, end: 4, text: "확인" }, "/w/a.hwp", "/w")
  assert.equal(create.name, "hwp_doc_create_memo")
  assert.equal(create.output, "/w/a_memo.hwp")
  assert.deepEqual(create.args, { target: { section: 0, para: 2, cellPath: [] }, start: 1, end: 4, text: "확인", author: DEFAULT_MEMO_AUTHOR })
  assert.equal(planMemo("update", { fieldId: 3, text: "고침" }, "/w/a.hwp", "/w").name, "hwp_doc_update_memo")
  assert.deepEqual(planMemo("delete", { fieldId: 3, output: "out.hwp" }, "/w/a.hwp", "/w"), {
    write: true,
    output: "/w/out.hwp",
    name: "hwp_doc_delete_memo",
    args: { fieldId: 3 },
  })
  assert.throws(() => planMemo("rename", {}, "/w/a.hwp", "/w"), /action은/)
  assert.throws(() => planMemo("create", { start: 4, end: 4, text: "x" }, "/w/a.hwp", "/w"), /end는/)
  assert.throws(() => planMemo("create", { start: 0, end: 1, text: " " }, "/w/a.hwp", "/w"), /text가 비어/)
  assert.throws(() => planMemo("create", { start: 0, end: 1, text: "x", cellPath: [[1, 2]] }, "/w/a.hwp", "/w"), /cellPath/)
  assert.throws(() => planMemo("update", { fieldId: 1 }, "/w/a.hwp", "/w"), /하나 이상/)
  assert.throws(() => planMemo("delete", { fieldId: -1 }, "/w/a.hwp", "/w"), /fieldId/)
  // The output must be an HWP document and never a key or secret file.
  assert.throws(() => planMemo("delete", { fieldId: 1, output: "/home/u/.ssh/authorized_keys" }, "/w/a.hwp", "/w"), /\.hwp/)
  assert.throws(() => planMemo("delete", { fieldId: 1, output: "/home/u/.ssh/x.hwp" }, "/w/a.hwp", "/w"), /비밀 파일/)
})

test("hwp_memo asks before a write and stops before rhwp runs when refused", async () => {
  const asked = []
  const denied = { directory: "/w", ask: async (req) => { asked.push(req); throw new Error("rejected") } }
  await assert.rejects(
    () => hwpMemo({ path: "/nope/a.hwp", action: "delete", memo: { fieldId: 1 } }, denied),
    /rejected/,
  )
  assert.equal(asked.length, 1)
  assert.equal(asked[0].permission, "edit")
  assert.deepEqual(asked[0].patterns, ["/nope/a_memo.hwp"])
})
