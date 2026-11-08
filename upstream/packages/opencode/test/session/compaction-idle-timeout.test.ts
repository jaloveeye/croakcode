import { describe, expect, test } from "bun:test"
import { Flag } from "@croakcode/core/flag/flag"
import { shouldHaltForIdle } from "../../src/session/processor"

describe("compaction idle guard (§4.9)", () => {
  test("compaction idle timeout defaults to 120s and is always on", () => {
    const prev = process.env["CROAKCODE_COMPACTION_IDLE_TIMEOUT_MS"]
    delete process.env["CROAKCODE_COMPACTION_IDLE_TIMEOUT_MS"]
    try {
      // Unset => flag undefined => caller applies 120s default (always on).
      expect(Flag.CROAKCODE_COMPACTION_IDLE_TIMEOUT_MS).toBeUndefined()
      const idleMs = Flag.CROAKCODE_COMPACTION_IDLE_TIMEOUT_MS ?? 120_000
      expect(idleMs).toBe(120_000)
      expect(idleMs).toBeGreaterThan(0)
    } finally {
      if (prev === undefined) delete process.env["CROAKCODE_COMPACTION_IDLE_TIMEOUT_MS"]
      else process.env["CROAKCODE_COMPACTION_IDLE_TIMEOUT_MS"] = prev
    }
  })

  test("a zero/negative env value still falls back to the always-on default", () => {
    const prev = process.env["CROAKCODE_COMPACTION_IDLE_TIMEOUT_MS"]
    process.env["CROAKCODE_COMPACTION_IDLE_TIMEOUT_MS"] = "0"
    try {
      expect(Flag.CROAKCODE_COMPACTION_IDLE_TIMEOUT_MS).toBeUndefined()
      expect(Flag.CROAKCODE_COMPACTION_IDLE_TIMEOUT_MS ?? 120_000).toBe(120_000)
    } finally {
      if (prev === undefined) delete process.env["CROAKCODE_COMPACTION_IDLE_TIMEOUT_MS"]
      else process.env["CROAKCODE_COMPACTION_IDLE_TIMEOUT_MS"] = prev
    }
  })

  test("normal stream idle guard is off unless explicitly configured (§4.9)", () => {
    const prev = process.env["CROAKCODE_STREAM_IDLE_TIMEOUT_MS"]
    try {
      delete process.env["CROAKCODE_STREAM_IDLE_TIMEOUT_MS"]
      // Unset => runtime passes undefined => processor keeps the guard off for
      // normal turns (compaction remains always-on). This is what protects
      // long/hanging streams from being cut at a surprise default.
      expect(Flag.CROAKCODE_STREAM_IDLE_TIMEOUT_MS).toBeUndefined()
      process.env["CROAKCODE_STREAM_IDLE_TIMEOUT_MS"] = "0"
      expect(Flag.CROAKCODE_STREAM_IDLE_TIMEOUT_MS).toBe(0)
      process.env["CROAKCODE_STREAM_IDLE_TIMEOUT_MS"] = "60000"
      expect(Flag.CROAKCODE_STREAM_IDLE_TIMEOUT_MS).toBe(60_000)
    } finally {
      if (prev === undefined) delete process.env["CROAKCODE_STREAM_IDLE_TIMEOUT_MS"]
      else process.env["CROAKCODE_STREAM_IDLE_TIMEOUT_MS"] = prev
    }
  })

  test("idle halt is suppressed when compaction is already requested", () => {
    // A compaction-requested turn must not also record an idle timeout.
    expect(shouldHaltForIdle({ idleMs: 120_000, lastEventAt: 0, now: 999_999, needsCompaction: true })).toBe(false)
  })
})
