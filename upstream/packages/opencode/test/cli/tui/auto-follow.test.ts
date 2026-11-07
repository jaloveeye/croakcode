import { expect, test } from "bun:test"
import { createIdleAutoFollow } from "@/cli/cmd/tui/routes/session/auto-follow"

function scheduler() {
  let id = 0
  const timers = new Map<number, { callback: () => void; delayMs: number }>()
  const cleared: number[] = []
  return {
    timers,
    cleared,
    api: {
      set(callback: () => void, delayMs: number) {
        const next = ++id
        timers.set(next, { callback, delayMs })
        return next
      },
      clear(handle: unknown) {
        const value = handle as number
        cleared.push(value)
        timers.delete(value)
      },
    },
    fire(handle: number) {
      const timer = timers.get(handle)
      timers.delete(handle)
      timer?.callback()
    },
  }
}

test("idle auto-follow returns an inactive scroller to the bottom", () => {
  const clock = scheduler()
  let bottom = false
  let scrolls = 0
  const follow = createIdleAutoFollow({
    delayMs: 30_000,
    isAtBottom: () => bottom,
    isBlocked: () => false,
    scrollToBottom: () => {
      bottom = true
      scrolls += 1
    },
    scheduler: clock.api,
  })

  follow.activity()
  expect([...clock.timers.values()].map((item) => item.delayMs)).toEqual([30_000])

  follow.activity()
  expect(clock.cleared).toEqual([1])
  expect([...clock.timers.keys()]).toEqual([2])

  clock.fire(2)
  expect(scrolls).toBe(1)
  expect(bottom).toBe(true)
  expect(clock.timers.size).toBe(0)
})

test("idle auto-follow defers for selections and dialogs without output extending the timer", () => {
  const clock = scheduler()
  let blocked = false
  let scrolls = 0
  const follow = createIdleAutoFollow({
    delayMs: 30_000,
    isAtBottom: () => false,
    isBlocked: () => blocked,
    scrollToBottom: () => {
      scrolls += 1
    },
    scheduler: clock.api,
  })

  follow.ensure()
  expect([...clock.timers.keys()]).toEqual([1])
  follow.ensure()
  expect([...clock.timers.keys()]).toEqual([1])

  blocked = true
  clock.fire(1)
  expect(scrolls).toBe(0)
  expect([...clock.timers.keys()]).toEqual([2])

  blocked = false
  clock.fire(2)
  expect(scrolls).toBe(1)
})

test("idle auto-follow cancels at the bottom and supports disabling", () => {
  const clock = scheduler()
  let bottom = false
  const follow = createIdleAutoFollow({
    delayMs: 30_000,
    isAtBottom: () => bottom,
    isBlocked: () => false,
    scrollToBottom: () => {},
    scheduler: clock.api,
  })

  follow.activity()
  bottom = true
  follow.ensure()
  expect(clock.timers.size).toBe(0)
  expect(clock.cleared).toEqual([1])

  const disabled = createIdleAutoFollow({
    delayMs: 0,
    isAtBottom: () => false,
    isBlocked: () => false,
    scrollToBottom: () => {},
    scheduler: clock.api,
  })
  disabled.activity()
  disabled.ensure()
  expect(clock.timers.size).toBe(0)
})
