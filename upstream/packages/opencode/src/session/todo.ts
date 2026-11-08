import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID } from "./schema"
import { Effect, Layer, Context, Schema } from "effect"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"
import { asc } from "drizzle-orm"
import { TodoTable } from "./session.sql"

export const Info = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"]).annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: Schema.optional(Schema.String).annotate({
    description: "Priority level of the task: high, medium, low",
  }),
  linkedToolCalls: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Tool call IDs this todo is backed by (evidence linkage)",
  }),
  evidence: Schema.optional(Schema.Literals(["tool", "none"])).annotate({
    description: 'Evidence policy: "tool" requires linked tool calls, "none" exempts them',
  }),
}).annotate({ identifier: "Todo" })
export type Info = Schema.Schema.Type<typeof Info>

export const Event = {
  Updated: BusEvent.define(
    "todo.updated",
    Schema.Struct({
      sessionID: SessionID,
      todos: Schema.Array(Info),
    }),
  ),
  Inconsistent: BusEvent.define(
    "todo.inconsistent",
    Schema.Struct({
      sessionID: SessionID,
      todo: Info,
      warnings: Schema.Array(Schema.String),
    }),
  ),
}

/**
 * 턴 종료 정합성 판정. evidence:"none" 은 도구 증거를 요구하지 않는다(오탐 방지).
 * in_progress 는 턴 단위 판정 금지 — 진입 턴(turnStartCalls)에만 확인한다.
 * upstream 내부 헬퍼(contracts import 금지 — 의존 규칙).
 */
export function consistencyWarnings(todo: Info, turnCalls: string[], turnStartCalls: string[]): string[] {
  const warnings: string[] = []
  const evidence = todo.evidence ?? "tool"
  const linked = todo.linkedToolCalls ?? []
  if (evidence === "tool" && todo.status === "completed" && linked.length === 0) {
    warnings.push("completed_without_evidence")
  }
  if (evidence === "tool" && todo.status === "in_progress") {
    const calledInEntryTurn = turnStartCalls.some((id) => linked.includes(id))
    if (turnStartCalls.length > 0 && !calledInEntryTurn && linked.length === 0) {
      warnings.push("in_progress_without_evidence")
    }
  }
  return warnings
}

export interface Interface {
  readonly update: (input: { sessionID: SessionID; todos: Info[] }) => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@croakcode/SessionTodo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const update = Effect.fn("Todo.update")(function* (input: { sessionID: SessionID; todos: Info[] }) {
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          db.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
          if (input.todos.length === 0) return
          db.insert(TodoTable)
            .values(
              input.todos.map((todo, position) => ({
                session_id: input.sessionID,
                content: todo.content,
                status: todo.status,
                priority: todo.priority ?? "medium",
                linkedToolCalls: JSON.stringify(todo.linkedToolCalls ?? []),
                evidence: todo.evidence ?? "tool",
                position,
              })),
            )
            .run()
        }),
      )
      yield* bus.publish(Event.Updated, input)
    })

    const get = Effect.fn("Todo.get")(function* (sessionID: SessionID) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select().from(TodoTable).where(eq(TodoTable.session_id, sessionID)).orderBy(asc(TodoTable.position)).all(),
        ),
      )
      return rows.map((row) => ({
        content: row.content,
        status: row.status as Info["status"],
        priority: row.priority,
        linkedToolCalls: JSON.parse(row.linkedToolCalls) as string[],
        evidence: row.evidence as NonNullable<Info["evidence"]>,
      }))
    })

    return Service.of({ update, get })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Todo from "./todo"
