import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "@/bus"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { SessionID } from "@/session/schema"
import { CrossSpawnSpawner } from "@croakcode/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

// See todo-consistency.test.ts for why there is no `disposeAllInstances` hook.
const it = testEffect(
  Layer.mergeAll(Bus.defaultLayer, Session.defaultLayer, Todo.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

describe("Todo subagent isolation (§4.8)", () => {
  it.instance("parent and child sessions keep separate todo lists", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const todo = yield* Todo.Service

      const parent = yield* sessions.create({ title: "parent" })
      const child = yield* sessions.create({ title: "child", parentID: parent.id })

      yield* todo.update({
        sessionID: parent.id,
        todos: [{ content: "parent task", status: "pending" }],
      })
      yield* todo.update({
        sessionID: child.id,
        todos: [{ content: "child task", status: "in_progress", linkedToolCalls: ["call_c"] }],
      })

      const parentTodos = yield* todo.get(parent.id)
      const childTodos = yield* todo.get(child.id)

      expect(parentTodos.map((t) => t.content)).toEqual(["parent task"])
      expect(childTodos.map((t) => t.content)).toEqual(["child task"])
      // Structural guarantee: TodoTable rows are keyed by session_id (FK).
      expect(parentTodos.some((t) => t.content === "child task")).toBe(false)
    }),
  )

  it.instance("removing the parent recursively deletes children and their todos (upstream behavior)", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const todo = yield* Todo.Service

      const parent = yield* sessions.create({ title: "parent2" })
      const child = yield* sessions.create({ title: "child2", parentID: parent.id })

      yield* todo.update({ sessionID: parent.id, todos: [{ content: "p", status: "pending" }] })
      yield* todo.update({ sessionID: child.id, todos: [{ content: "c", status: "pending" }] })

      // Session.remove recurses into children (session.ts:605-608), so both the
      // child session and its todos are cascaded away. Isolation still holds:
      // the parent's todos never absorbed the child's.
      yield* sessions.remove(parent.id)

      const parentTodos = yield* todo.get(parent.id)
      const childTodos = yield* todo.get(child.id)
      expect(parentTodos).toEqual([])
      expect(childTodos).toEqual([])
    }),
  )

  it.instance("a session id with no todos returns an empty list", () =>
    Effect.gen(function* () {
      const todo = yield* Todo.Service
      const orphan = SessionID.make("ses_orphan_probe")
      const rows = yield* todo.get(orphan)
      expect(rows).toEqual([])
    }),
  )
})
