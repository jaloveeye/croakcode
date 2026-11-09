import { beforeEach, describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Cause, Effect, Exit, Layer } from "effect"
import { Database } from "@/storage/db"
import { DelegationGrantTable } from "../../src/delegation/delegation.sql"
import { Effective } from "../../src/delegation/effective"
import { Grants } from "../../src/delegation/grants"
import { Guard } from "../../src/delegation/guard"
import { Registry } from "../../src/delegation/registry"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Registry.defaultLayer, Grants.defaultLayer, Guard.defaultLayer))

// Tests in one file share the database, so each test gets its own session ids.
let salt = ""
beforeEach(() => {
  salt = Math.random().toString(36).slice(2, 10)
})
const session = (n: number) => SessionID.make(`ses_${salt}${String(n).padStart(18, "0")}`)
const allow = (permission: string, pattern = "*") => ({ permission, pattern, action: "allow" as const })
const deny = (permission: string, pattern = "*") => ({ permission, pattern, action: "deny" as const })

const reason = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return "allowed"
  const err = Cause.squash(exit.cause) as { _tag?: string; reason?: string }
  return err._tag === "DelegationDeniedError" ? err.reason : String(err)
}

const parentAndChild = Effect.fn("test.parentAndChild")(function* (childRules = [allow("*")]) {
  const guard = yield* Guard.Service
  const registry = yield* Registry.Service
  yield* guard.beginRun({ sessionID: session(1), agent: "build" })
  yield* guard.delegate({
    parentSessionID: session(1),
    childSessionID: session(2),
    agent: "general",
    capabilities: childRules,
    inherited: [deny("todowrite")],
  })
  const child = yield* registry.activeRun(session(2))
  return { guard, registry, child: child! }
})

describe("delegation guard (Phase 4 Task 5/6)", () => {
  it.instance("a root session runs under a root principal owned by the local human", () =>
    Effect.gen(function* () {
      const guard = yield* Guard.Service
      const registry = yield* Registry.Service
      yield* guard.beginRun({ sessionID: session(1), agent: "build" })
      const run = yield* registry.activeRun(session(1))
      expect(run).toBeDefined()
      const principal = yield* registry.getPrincipal(run!.principalId)
      expect(principal?.ownerId).toBe("human:local")
      expect(reason(yield* guard.checkTool(session(1), "read").pipe(Effect.exit))).toBe("allowed")
      // The next loop reuses the same root principal.
      yield* guard.endRun(session(1), "completed")
      yield* guard.beginRun({ sessionID: session(1), agent: "build" })
      expect((yield* registry.activeRun(session(1)))?.principalId).toBe(principal!.id)
    }),
  )

  it.instance("DG-01: a child session without a delegated run is denied every tool", () =>
    Effect.gen(function* () {
      const guard = yield* Guard.Service
      yield* guard.beginRun({ sessionID: session(1), agent: "build" })
      yield* guard.beginRun({ sessionID: session(2), parentID: session(1), agent: "general" })
      expect(reason(yield* guard.checkTool(session(2), "read").pipe(Effect.exit))).toBe("no_run")
      expect(reason(yield* guard.checkPatterns(session(2), "read", ["/tmp/x"]).pipe(Effect.exit))).toBe("no_run")
    }),
  )

  it.instance("Task 6: delegate links principal, grant and run to the parent run", () =>
    Effect.gen(function* () {
      const { registry, child } = yield* parentAndChild()
      const grants = yield* Grants.Service
      const parentRun = yield* registry.activeRun(session(1))
      expect(child.parentRunId).toBe(parentRun!.id)
      const principal = yield* registry.getPrincipal(child.principalId)
      expect(principal?.ownerId).toBe(parentRun!.principalId)
      const grant = yield* grants.get(child.grantId!)
      expect(grant?.parentRunId).toBe(parentRun!.id)
      expect(grant?.depth).toBe(1)
      expect(grant?.delegateePrincipalId).toBe(child.principalId)
    }),
  )

  it.instance("Task 6: the child's own rules and the inherited ceiling apply", () =>
    Effect.gen(function* () {
      const { guard } = yield* parentAndChild([allow("*"), deny("bash")])
      expect(reason(yield* guard.checkTool(session(2), "read").pipe(Effect.exit))).toBe("allowed")
      expect(reason(yield* guard.checkTool(session(2), "bash").pipe(Effect.exit))).toBe("layer_decision")
      expect(reason(yield* guard.checkTool(session(2), "todowrite").pipe(Effect.exit))).toBe("layer_decision")
    }),
  )

  it.instance("Task 6: delegation needs an active parent run", () =>
    Effect.gen(function* () {
      const guard = yield* Guard.Service
      const exit = yield* guard
        .delegate({ parentSessionID: session(1), childSessionID: session(2), agent: "general", capabilities: [allow("*")], inherited: [] })
        .pipe(Effect.exit)
      expect(reason(exit)).toBe("no_parent_run")
    }),
  )

  it.instance("RV-03: a revoked grant denies the next tool call", () =>
    Effect.gen(function* () {
      const { guard, child } = yield* parentAndChild()
      expect(reason(yield* guard.checkTool(session(2), "read").pipe(Effect.exit))).toBe("allowed")
      yield* Effect.sync(() =>
        Database.use((db) =>
          db.update(DelegationGrantTable).set({ status: "revoked" }).where(eq(DelegationGrantTable.id, child.grantId!)).run(),
        ),
      )
      expect(reason(yield* guard.checkTool(session(2), "read").pipe(Effect.exit))).toBe("grant_inactive")
      expect(reason(yield* guard.checkPatterns(session(2), "read", ["/tmp/a"]).pipe(Effect.exit))).toBe("grant_inactive")
    }),
  )

  it.instance("RV-05: a grant past its expiry is recorded expired and denies", () =>
    Effect.gen(function* () {
      const { guard, child } = yield* parentAndChild()
      const grants = yield* Grants.Service
      yield* Effect.sync(() =>
        Database.use((db) =>
          db.update(DelegationGrantTable).set({ expires_at: Date.now() - 1 }).where(eq(DelegationGrantTable.id, child.grantId!)).run(),
        ),
      )
      expect(reason(yield* guard.checkTool(session(2), "read").pipe(Effect.exit))).toBe("grant_inactive")
      expect((yield* grants.get(child.grantId!))?.status).toBe("expired")
    }),
  )

  it.instance("a revoked delegatee principal denies the next tool call", () =>
    Effect.gen(function* () {
      const { guard, registry, child } = yield* parentAndChild()
      yield* registry.revokePrincipal(child.principalId, "test")
      expect(reason(yield* guard.checkTool(session(2), "read").pipe(Effect.exit))).toBe("principal_inactive")
    }),
  )

  it.instance("a path outside the worktree is outside a delegated child's scope", () =>
    Effect.gen(function* () {
      const { guard } = yield* parentAndChild()
      expect(reason(yield* guard.checkPatterns(session(2), "read", ["/definitely/outside/secret"]).pipe(Effect.exit))).toBe(
        "out_of_scope",
      )
      // The root session is not scope-limited by the delegation layer.
      expect(reason(yield* guard.checkPatterns(session(1), "read", ["/definitely/outside/secret"]).pipe(Effect.exit))).toBe(
        "allowed",
      )
    }),
  )
})

describe("context isolation (Phase 4 Task 6a)", () => {
  it.instance("CX-04: a child session cannot be resumed by a delegator that does not own it", () =>
    Effect.gen(function* () {
      const guard = yield* Guard.Service
      const registry = yield* Registry.Service
      // Parent P1 delegates child C.
      yield* guard.beginRun({ sessionID: session(1), agent: "build" })
      yield* guard.delegate({ parentSessionID: session(1), childSessionID: session(3), agent: "general", capabilities: [allow("*")], inherited: [] })
      yield* guard.endRun(session(3), "completed")
      // Another root session P2 tries to resume C.
      yield* guard.beginRun({ sessionID: session(2), agent: "build" })
      const foreign = yield* guard
        .delegate({ parentSessionID: session(2), childSessionID: session(3), agent: "general", capabilities: [allow("*")], inherited: [] })
        .pipe(Effect.exit)
      expect(reason(foreign)).toBe("context_out_of_scope")
      expect(yield* registry.activeRun(session(3))).toBeUndefined()
      // P1 itself may resume C, under the same child principal.
      const before = (yield* registry.getRun((yield* guard.delegate({ parentSessionID: session(1), childSessionID: session(3), agent: "general", capabilities: [allow("*")], inherited: [] })).runId))!
      expect((yield* registry.getPrincipal(before.principalId))?.ownerId).toBe((yield* registry.activeRun(session(1)))!.principalId)
    }),
  )

  it.instance("CX-03: a child result is deliverable only to the session of the run that delegated it", () =>
    Effect.gen(function* () {
      const guard = yield* Guard.Service
      yield* guard.beginRun({ sessionID: session(1), agent: "build" })
      yield* guard.beginRun({ sessionID: session(2), agent: "build" })
      const { runId } = yield* guard.delegate({
        parentSessionID: session(1),
        childSessionID: session(3),
        agent: "general",
        capabilities: [allow("*")],
        inherited: [],
      })
      expect(yield* guard.deliverable(runId, session(1))).toBe(true)
      expect(yield* guard.deliverable(runId, session(2))).toBe(false)
      expect(yield* guard.deliverable(runId, session(3))).toBe(false)
      // A parent loop that ended and restarted is the same session: still deliverable.
      yield* guard.endRun(session(1), "completed")
      yield* guard.beginRun({ sessionID: session(1), agent: "build" })
      expect(yield* guard.deliverable(runId, session(1))).toBe(true)
    }),
  )
})

// RV-04: state that cannot be read is a deny.
const brokenRegistry = Layer.succeed(
  Registry.Service,
  Registry.Service.of({
    issuePrincipal: () => Effect.die("db down"),
    getPrincipal: () => Effect.die("db down"),
    listByOwner: () => Effect.die("db down"),
    revokePrincipal: () => Effect.die("db down"),
    startRun: () => Effect.die("db down"),
    endRun: () => Effect.die("db down"),
    getRun: () => Effect.die("db down"),
    activeRun: () => Effect.die("db down"),
  }),
)
const brokenGuard = Guard.layer.pipe(
  Layer.provide(Effective.layer.pipe(Layer.provide(Layer.mergeAll(brokenRegistry, Grants.layer.pipe(Layer.provide(brokenRegistry)))))),
  Layer.provide(Grants.layer.pipe(Layer.provide(brokenRegistry))),
  Layer.provide(brokenRegistry),
)
const broken = testEffect(brokenGuard)

describe("RV-04: unreadable delegation state denies", () => {
  broken.instance("a registry that cannot be read denies the tool", () =>
    Effect.gen(function* () {
      const guard = yield* Guard.Service
      expect(reason(yield* guard.checkTool(session(1), "read").pipe(Effect.exit))).toBe("no_run")
    }),
  )
})

// An active run whose chain cannot be read: the effective layer turns the defect into a deny.
const flakyRegistry = Effect.gen(function* () {
  const real = yield* Registry.Service
  return Registry.Service.of({ ...real, getRun: () => Effect.die("db down") })
})
const flakyGuard = Guard.layer.pipe(
  Layer.provide(
    Effective.layer.pipe(
      Layer.provide(Layer.mergeAll(Layer.effect(Registry.Service, flakyRegistry).pipe(Layer.provide(Registry.defaultLayer)), Grants.defaultLayer)),
    ),
  ),
  Layer.provide(Grants.defaultLayer),
  Layer.provide(Registry.defaultLayer),
)
const flaky = testEffect(Layer.mergeAll(flakyGuard, Registry.defaultLayer))

describe("RV-04: an unreadable chain denies", () => {
  flaky.instance("the effective decision is a deny with state_unreadable", () =>
    Effect.gen(function* () {
      const guard = yield* Guard.Service
      yield* guard.beginRun({ sessionID: session(1), agent: "build" })
      expect(reason(yield* guard.checkTool(session(1), "read").pipe(Effect.exit))).toBe("state_unreadable")
    }),
  )
})
