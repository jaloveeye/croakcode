import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "@/bus"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { CrossSpawnSpawner } from "@croakcode/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

// Note: no `afterEach(disposeAllInstances)` here on purpose. Disposing the
// shared instance runtime tears down the Bus fiber that `Todo.update` publishes
// on, which then dies with "Service not found" between tests. Each `it.instance`
// already gets an isolated temp dir + in-memory DB, and test/preload.ts handles
// global teardown via its `afterAll`.
const it = testEffect(
  Layer.mergeAll(Bus.defaultLayer, Session.defaultLayer, Todo.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

describe("Todo consistency (§4.8)", () => {
  // Pure-function cases do not require the service context, so they run with
  // bun's plain `test` rather than `it.instance`.
  describe("consistencyWarnings (pure)", () => {
    test("evidence:tool completed without linked calls warns", () => {
      expect(
        Todo.consistencyWarnings({ content: "x", status: "completed", evidence: "tool", linkedToolCalls: [] }, [], []),
      ).toEqual(["completed_without_evidence"])
    })

    test("evidence:none completed without linked calls does NOT warn (avoids false positive)", () => {
      expect(
        Todo.consistencyWarnings(
          { content: "analysis", status: "completed", evidence: "none", linkedToolCalls: [] },
          [],
          [],
        ),
      ).toEqual([])
    })

    test("completed with a linked call is consistent", () => {
      expect(
        Todo.consistencyWarnings(
          { content: "x", status: "completed", evidence: "tool", linkedToolCalls: ["call_1"] },
          ["call_1"],
          [],
        ),
      ).toEqual([])
    })

    test("in_progress spanning turns is not a false positive", () => {
      expect(
        Todo.consistencyWarnings(
          { content: "x", status: "in_progress", linkedToolCalls: ["call_1"] },
          ["call_1"],
          ["call_1"],
        ),
      ).toEqual([])
    })

    test("in_progress entered with no tool calls warns", () => {
      expect(
        Todo.consistencyWarnings({ content: "x", status: "in_progress", linkedToolCalls: [] }, [], ["call_x"]),
      ).toEqual(["in_progress_without_evidence"])
    })
  })

  describe("publishing + persistence", () => {
    it.instance("declares todo.inconsistent event and persists evidence round-trip", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todo = yield* Todo.Service
        const session = yield* sessions.create({ title: "consistency" })

        yield* todo.update({
          sessionID: session.id,
          todos: [{ content: "do thing", status: "completed", evidence: "tool", linkedToolCalls: [] }],
        })

        // The turn-end publish lives in prompt.ts; here we assert the event is
        // declared and the stored todo round-trips with its evidence fields.
        expect(Todo.Event.Inconsistent.type).toBe("todo.inconsistent")
        const stored = yield* todo.get(session.id)
        expect(stored).toHaveLength(1)
        expect(stored[0]!.evidence).toBe("tool")
        expect(stored[0]!.linkedToolCalls).toEqual([])
      }),
    )

    it.instance("persists evidence:none and linked calls through update/get", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const todo = yield* Todo.Service
        const session = yield* sessions.create({ title: "persist" })

        yield* todo.update({
          sessionID: session.id,
          todos: [
            { content: "analysis", status: "completed", evidence: "none" },
            { content: "build", status: "in_progress", evidence: "tool", linkedToolCalls: ["call_9"] },
          ],
        })

        const stored = yield* todo.get(session.id)
        expect(stored.map((t) => t.evidence)).toEqual(["none", "tool"])
        expect(stored[1]!.linkedToolCalls).toEqual(["call_9"])
      }),
    )
  })
})
