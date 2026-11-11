import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const dir = mkdtempSync(path.join(tmpdir(), "croak-models-"))
process.env.CROAK_CONFIG_DIR = dir // no session.json: logged out
const plugin = await import("../upstream/.croakcode/plugins/croak-models.js")

const gateList = [{ id: "croak", display: "사내 모델", levels: ["none", "low", "high"], default_level: "none", limits: { context: 1000, output: 100 } }]
const config = () => ({ provider: { "litellm-head": { models: { croak: { name: "old" }, default: { name: "이전" } } } } })

test("the gate's list becomes models with one variant per reasoning level", () => {
  const cfg = config()
  assert.equal(plugin.applyList(cfg, gateList), true)
  assert.deepEqual(cfg.provider["litellm-head"].models.croak, {
    name: "사내 모델",
    variants: { none: { reasoningEffort: "none" }, low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } },
    limit: { context: 1000, output: 100 },
  })
  // Aliases only in the product config (older sessions) stay.
  assert.deepEqual(cfg.provider["litellm-head"].models.default, { name: "이전" })
})

test("a new level at the gate appears without a croakcode release", () => {
  const cfg = config()
  plugin.applyList(cfg, [{ ...gateList[0], levels: ["none", "low", "high", "max"] }])
  assert.deepEqual(Object.keys(cfg.provider["litellm-head"].models.croak.variants), ["none", "low", "high", "max"])
})

test("no list, an empty list or no provider leaves the config as it is", () => {
  for (const list of [null, [], "x"]) {
    const cfg = config()
    assert.equal(plugin.applyList(cfg, list), false)
    assert.deepEqual(cfg, config())
  }
  assert.equal(plugin.applyList({}, gateList), false)
})

test("logged out: the config hook uses the cached list, or nothing without one", async () => {
  const hooks = await plugin.server()
  const untouched = config()
  await hooks.config(untouched)
  assert.deepEqual(untouched, config())
  writeFileSync(plugin.cacheFile(), JSON.stringify(gateList))
  const cached = config()
  await hooks.config(cached)
  assert.equal(cached.provider["litellm-head"].models.croak.name, "사내 모델")
})
