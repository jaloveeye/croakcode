import { test, expect } from "bun:test"
import { createTuiPluginApi } from "../fixture/tui-plugin"

type SlotReg = { order?: number; slots?: Record<string, unknown> }

// usage-panel registers three host slots with `order: 90`. The host slot map
// (TuiHostSlotMap) defines session_id / message_id; this test pins the names and
// the order so the plugin keeps rendering in the right places.
test("usage-panel registers the three host slots with order 90", async () => {
  const slots: SlotReg[] = []
  const api = createTuiPluginApi()
  ;(api as any).slots = {
    register(reg: SlotReg) {
      slots.push(reg)
      return () => {}
    },
  }
  const mod = (await import("../../../../.croakcode/plugins/usage-panel/index.tsx")).default
  expect(mod.id).toBe("croak-usage-panel")
  expect(typeof mod.tui).toBe("function")

  await mod.tui(api, { avatar: false })

  expect(slots.length).toBe(1)
  const reg = slots[0]!
  expect(reg.order).toBe(90)
  expect(typeof reg.slots?.session_message_footer).toBe("function")
  expect(typeof reg.slots?.session_prompt_right).toBe("function")
  expect(typeof reg.slots?.sidebar_content).toBe("function")
})
