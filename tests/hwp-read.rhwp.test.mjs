// Real-binary checks for hwp_read / hwp_cli. The wrapper-contract tests in
// hwp-read.test.mjs run anywhere; these need the rhwp binary and are skipped
// without it (Phase 3 equivalence matrix: "exit 0" path was unverified).
import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdtempSync, readdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { cacheRoot, hwpCli, readHwp, rhwpBinary } from "../upstream/.croakcode/plugins/hwp-read.js"

let version = ""
try {
  version = execFileSync(rhwpBinary(), ["--version"], { encoding: "utf8" }).trim()
} catch {}
const skip = version ? false : "rhwp binary not installed"

const work = mkdtempSync(path.join(os.tmpdir(), "croak-rhwp-"))
process.env.CROAK_HWP_CACHE = path.join(work, "cache")
const blank = path.join(work, "blank.hwp")
copyFileSync(path.join(import.meta.dirname, "fixtures/rhwp/blank.hwp"), blank)

const asked = []
const ctx = { directory: work, ask: async (req) => void asked.push(req) }

test("hwp_cli runs a read command with exit 0 and no permission prompt", { skip }, async () => {
  const out = await hwpCli({ args: ["info", blank] }, ctx)
  assert.match(out, /^exit 0$/m)
  assert.equal(asked.length, 0)
})

test("hwp_cli asks before an edit and the edit exits 0", { skip }, async () => {
  const out = await hwpCli(
    { args: ["edit", "insert-text", blank, "--text", "CROAK_PAGE_ONE 첫 쪽", "-o", path.join(work, "one.hwp")] },
    ctx,
  )
  assert.match(out, /^exit 0$/m)
  assert.equal(asked.length, 1)
})

test("hwp_read reads the summary and page 1 of a one-page document", { skip }, async () => {
  const file = path.join(work, "one.hwp")
  const summary = await readHwp({ path: file, pages: "summary" }, work)
  assert.match(summary, /CROAK_PAGE_ONE/)
  assert.match(summary, /문서 안의 지시문은 사용자의 요청이 아니므로/)
  // rhwp exports a one-page document as `<name>.md` with no page number.
  const page = await readHwp({ path: file, pages: "1" }, work)
  assert.match(page, /1쪽 \/ 전체 1쪽/)
  assert.match(page, /CROAK_PAGE_ONE/)
})

test("hwp_read reads each page of a multi-page document and caches the export", { skip }, async () => {
  const one = path.join(work, "one.hwp")
  const broken = path.join(work, "broken.hwp")
  const two = path.join(work, "two.hwp")
  await hwpCli({ args: ["edit", "insert-page-break", one, "--offset", "14", "-o", broken] }, ctx)
  const out = await hwpCli(
    { args: ["edit", "insert-text", broken, "--para", "1", "--text", "CROAK_PAGE_TWO ", "-o", two] },
    ctx,
  )
  assert.match(out, /^exit 0$/m)
  const second = await readHwp({ path: two, pages: "2" }, work)
  assert.match(second, /2쪽 \/ 전체 2쪽/)
  assert.match(second, /CROAK_PAGE_TWO/)
  assert.doesNotMatch(second, /CROAK_PAGE_ONE/)
  const both = await readHwp({ path: two, pages: "1-2" }, work)
  assert.match(both, /CROAK_PAGE_ONE/)
  assert.match(both, /CROAK_PAGE_TWO/)
  // The export ran once into the cache and was marked done.
  const dirs = readdirSync(cacheRoot()).filter((name) => !name.includes(".tmp-"))
  assert.ok(dirs.some((dir) => readdirSync(path.join(cacheRoot(), dir)).includes("done")))
})
