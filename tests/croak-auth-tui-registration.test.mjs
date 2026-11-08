// Registration contract for the croak-auth TUI plugin as shipped in the config dir.
// `tui.json` lists the plugin as a path relative to `.croakcode/`; the TUI loader resolves
// that to a file URL (verified with PluginLoader.resolve). This test guards the config
// wiring so a rename or a typo fails loudly instead of silently dropping /login.
import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const configDir = path.join(root, "upstream", ".croakcode")

test("tui.json registers the croak-auth TUI plugin by relative path", () => {
  const file = path.join(configDir, "tui.json")
  assert.ok(existsSync(file), "tui.json must exist")
  const json = JSON.parse(readFileSync(file, "utf8"))
  assert.ok(Array.isArray(json.plugin), "plugin must be an array")
  const specs = json.plugin.map((p) => (Array.isArray(p) ? p[0] : p))
  assert.ok(specs.includes("./plugins/croak-auth-tui.tsx"), `expected croak-auth-tui registration, got ${specs.join(",")}`)

  const target = path.join(configDir, "./plugins/croak-auth-tui.tsx")
  assert.ok(existsSync(target), `registered plugin file missing: ${target}`)
})

test("croak-auth TUI sources import ported libs, not the original .mjs paths", () => {
  const src = readFileSync(path.join(configDir, "plugins", "croak-auth-tui.tsx"), "utf8")
  assert.match(src, /from "\.\/lib\/policy-state\.js"/)
  assert.match(src, /from "\.\/lib\/croak-auth-session\.js"/)
  assert.doesNotMatch(src, /\.mjs"/)
})
