import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Registry } from "../../src/delegation/registry"
import { HUMAN_LOCAL, PrincipalID, RunID } from "../../src/delegation/schema"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Registry.defaultLayer))

const rules = [{ permission: "read", pattern: "*", action: "allow" as const }]
const root = (registry: Registry.Interface, definition = "build") =>
  registry.issuePrincipal({ ownerId: HUMAN_LOCAL, definition, role: "orchestrator", capabilities: rules })
const session = (n: number) => SessionID.make(`ses_${String(n).padStart(26, "0")}`)

describe("Agent Registry (Phase 4 Task 2)", () => {
  it.instance("AG-02: the runtime issues the principal id and records who issued it", () =>
    Effect.gen(function* () {
      const registry = yield* Registry.Service
      const principal = yield* root(registry)
      expect(principal.id.startsWith("apr")).toBe(true)
      expect(principal.createdBy).toBe("runtime")
      expect(principal.status).toBe("active")
      expect(principal.ownerId).toBe(HUMAN_LOCAL)
      expect(yield* registry.getPrincipal(principal.id)).toEqual(principal)
    }),
  )

  it.instance("AG-03: one definition can back several distinct principals", () =>
    Effect.gen(function* () {
      const registry = yield* Registry.Service
      const a = yield* root(registry, "general")
      const b = yield* root(registry, "general")
      expect(a.id).not.toBe(b.id)
      expect(a.definition).toBe(b.definition)
    }),
  )

  it.instance("a child principal needs an existing, active owner", () =>
    Effect.gen(function* () {
      const registry = yield* Registry.Service
      const parent = yield* root(registry)
      const child = yield* registry.issuePrincipal({
        ownerId: parent.id,
        definition: "general",
        role: "developer",
        capabilities: rules,
      })
      expect(child.ownerId).toBe(parent.id)
      expect((yield* registry.listByOwner(parent.id)).map((p) => p.id)).toEqual([child.id])

      const unknown = yield* registry
        .issuePrincipal({ ownerId: PrincipalID.ascending(), definition: "general", role: "x", capabilities: rules })
        .pipe(Effect.exit)
      expect(Exit.isFailure(unknown)).toBe(true)

      yield* registry.revokePrincipal(parent.id, "test")
      const fromRevoked = yield* registry
        .issuePrincipal({ ownerId: parent.id, definition: "general", role: "x", capabilities: rules })
        .pipe(Effect.exit)
      expect(Exit.isFailure(fromRevoked)).toBe(true)
    }),
  )

  it.instance("an owner id that is neither the local human nor a principal id is rejected", () =>
    Effect.gen(function* () {
      const registry = yield* Registry.Service
      const exit = yield* registry
        .issuePrincipal({ ownerId: "agent: trust me", definition: "build", role: "x", capabilities: rules })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("AG-04: a run references exactly one existing, active principal", () =>
    Effect.gen(function* () {
      const registry = yield* Registry.Service
      const principal = yield* root(registry)
      const run = yield* registry.startRun({ principalId: principal.id, sessionId: session(1), policyRevision: 0 })
      expect(run.id.startsWith("run")).toBe(true)
      expect(run.principalId).toBe(principal.id)
      expect(run.status).toBe("running")
      expect(run.parentRunId).toBeUndefined()

      const unknown = yield* registry
        .startRun({ principalId: PrincipalID.ascending(), sessionId: session(2), policyRevision: 0 })
        .pipe(Effect.exit)
      expect(Exit.isFailure(unknown)).toBe(true)

      yield* registry.revokePrincipal(principal.id, "test")
      expect((yield* registry.getPrincipal(principal.id))?.status).toBe("revoked")
      const revoked = yield* registry
        .startRun({ principalId: principal.id, sessionId: session(3), policyRevision: 0 })
        .pipe(Effect.exit)
      expect(Exit.isFailure(revoked)).toBe(true)
    }),
  )

  it.instance("a run's parent must exist", () =>
    Effect.gen(function* () {
      const registry = yield* Registry.Service
      const principal = yield* root(registry)
      const parent = yield* registry.startRun({ principalId: principal.id, sessionId: session(1), policyRevision: 0 })
      const child = yield* registry.startRun({
        principalId: principal.id,
        sessionId: session(2),
        parentRunId: parent.id,
        policyRevision: 0,
      })
      expect(child.parentRunId).toBe(parent.id)

      const orphan = yield* registry
        .startRun({ principalId: principal.id, sessionId: session(3), parentRunId: RunID.ascending(), policyRevision: 0 })
        .pipe(Effect.exit)
      expect(Exit.isFailure(orphan)).toBe(true)
    }),
  )

  it.instance("ending a run records its outcome once", () =>
    Effect.gen(function* () {
      const registry = yield* Registry.Service
      const principal = yield* root(registry)
      const run = yield* registry.startRun({ principalId: principal.id, sessionId: session(1), policyRevision: 0 })
      yield* registry.endRun(run.id, "completed")
      const ended = yield* registry.getRun(run.id)
      expect(ended?.status).toBe("completed")
      expect(ended?.timeEnded).toBeGreaterThan(0)
      // A finished run keeps its first outcome.
      yield* registry.endRun(run.id, "aborted")
      expect((yield* registry.getRun(run.id))?.status).toBe("completed")
      expect(yield* registry.activeRun(session(1))).toBeUndefined()
    }),
  )

  it.instance("INV-2.4: starting a run closes the session's previous active run", () =>
    Effect.gen(function* () {
      const registry = yield* Registry.Service
      const principal = yield* root(registry)
      const first = yield* registry.startRun({ principalId: principal.id, sessionId: session(1), policyRevision: 0 })
      const second = yield* registry.startRun({ principalId: principal.id, sessionId: session(1), policyRevision: 0 })
      expect((yield* registry.getRun(first.id))?.status).toBe("aborted")
      expect((yield* registry.activeRun(session(1)))?.id).toBe(second.id)
    }),
  )
})
