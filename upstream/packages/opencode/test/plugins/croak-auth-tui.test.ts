import { test, expect } from "bun:test"
import { createTuiPluginApi } from "../fixture/tui-plugin"

// The shared fixture stubs `slots.register` as a no-op. The slot registration
// contract is what this test pins, so build the api and then override slots.
function apiWithSlots(slots: SlotReg[], layers: Layer[]) {
  const api = createTuiPluginApi({
    keymap: {
      registerLayer(layer: Layer) {
        layers.push(layer)
        return () => {}
      },
    } as never,
  })
  ;(api as any).slots = {
    register(reg: SlotReg) {
      slots.push(reg)
      return () => {}
    },
  }
  return api
}

type Layer = { commands?: Array<{ name?: string; slashName?: string; run?: unknown }> }
type SlotReg = { slots?: Record<string, unknown> }

// The croak-auth TUI plugin registers its slash commands through
// `api.keymap.registerLayer({ commands: [{ slashName, run }] })` and its account
// widgets through `api.slots.register({ slots: { sidebar_content, home_prompt_right } })`.
// This test pins that registration contract without rendering the widgets.
test("croak-auth TUI registers /login /logout /whoami /agent-perm and both slots", async () => {
  const layers: Layer[] = []
  const slots: SlotReg[] = []
  const api = apiWithSlots(slots, layers)

  const mod = (await import("../../../../.croakcode/plugins/croak-auth-tui.tsx")).default
  expect(mod.id).toBe("croak-auth-tui")
  expect(typeof mod.tui).toBe("function")

  await mod.tui(api, {})

  const slash = layers.flatMap((l) => (l.commands ?? []).map((c) => c.slashName)).filter((s): s is string => !!s)
  for (const name of ["login", "logout", "whoami", "agent-perm"]) {
    expect(slash).toContain(name)
  }
  expect(slash.length).toBe(4)
  expect(slash).toEqual(["login", "logout", "whoami", "agent-perm"])

  const all = Object.assign({}, ...slots.map((s) => s.slots ?? {}))
  expect(typeof all.sidebar_content).toBe("function")
  expect(typeof all.home_prompt_right).toBe("function")
})

test("croak-auth TUI slash commands are callable palette entries", async () => {
  const layers: Layer[] = []
  const api = createTuiPluginApi({
    keymap: {
      registerLayer(layer: Layer) {
        layers.push(layer)
        return () => {}
      },
    } as never,
  })
  const mod = (await import("../../../../.croakcode/plugins/croak-auth-tui.tsx")).default
  await mod.tui(api, {})
  const commands = layers.flatMap((l) => l.commands ?? [])
  for (const cmd of commands) expect(typeof cmd.run).toBe("function")
})
