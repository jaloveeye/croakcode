import { describe, expect, test } from "bun:test"
import { Duration, Effect, Stream } from "effect"
import { shouldHaltForIdle } from "../../src/session/processor"
import { MessageV2 } from "../../src/session/message-v2"

describe("stream idle guard (§4.9)", () => {
  describe("shouldHaltForIdle", () => {
    test("halts when the gap reaches the idle window", () => {
      expect(shouldHaltForIdle({ idleMs: 60_000, lastEventAt: 0, now: 60_000, needsCompaction: false })).toBe(true)
    })

    test("does not halt while deltas keep arriving faster than the window", () => {
      expect(shouldHaltForIdle({ idleMs: 60_000, lastEventAt: 0, now: 59_999, needsCompaction: false })).toBe(false)
    })

    test("disabled (idleMs 0) never halts", () => {
      expect(shouldHaltForIdle({ idleMs: 0, lastEventAt: 0, now: 1_000_000, needsCompaction: false })).toBe(false)
    })

    test("never halts when compaction was requested", () => {
      expect(shouldHaltForIdle({ idleMs: 60_000, lastEventAt: 0, now: 10_000_000, needsCompaction: true })).toBe(false)
    })
  })

  describe("Stream.timeout watches delta gaps, not total runtime", () => {
    test("a long stream with steady deltas is not cut short", async () => {
      // 6 values, 40ms apart => total ~240ms > idleMs(120) but each gap < idleMs.
      const values = await Effect.runPromise(
        Stream.fromIterable([0, 1, 2, 3, 4, 5]).pipe(
          Stream.mapEffect((n) => Effect.sleep(Duration.millis(40)).pipe(Effect.as(n))),
          Stream.timeout(Duration.millis(120)),
          Stream.runCollect,
        ),
      )
      expect(Array.from(values)).toEqual([0, 1, 2, 3, 4, 5])
    })

    test("a stalled stream is ended by Stream.timeout", async () => {
      const start = Date.now()
      const values = await Effect.runPromise(
        Stream.fromIterable([0, 1]).pipe(
          Stream.mapEffect((n) =>
            n === 0 ? Effect.succeed(n) : Effect.sleep(Duration.millis(400)).pipe(Effect.as(n)),
          ),
          Stream.timeout(Duration.millis(80)),
          Stream.runCollect,
        ),
      )
      // The second value (after the long gap) never arrives.
      expect(Array.from(values)).toEqual([0])
      expect(Date.now() - start).toBeLessThan(350)
    })
  })

  describe("error mapping", () => {
    test("StreamIdleTimeoutError maps to STREAM_IDLE_TIMEOUT and is not retryable", () => {
      const mapped = MessageV2.fromError(
        new MessageV2.StreamIdleTimeoutError({
          message: "stream produced no data for 60000ms",
          errorCode: "STREAM_IDLE_TIMEOUT",
          idleMs: 60000,
        }),
        { providerID: "test" as never },
      )
      expect(mapped.name).toBe("APIError")
      expect(mapped.data).toMatchObject({
        isRetryable: false,
        metadata: { code: "STREAM_IDLE_TIMEOUT" },
      })
    })
  })
})
