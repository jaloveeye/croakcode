import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@/storage/db"
import { Audit } from "../../src/delegation/audit"
import { ExecutionAuditTable } from "../../src/delegation/delegation.sql"
import { Grants } from "../../src/delegation/grants"
import { Guard } from "../../src/delegation/guard"
import { Registry } from "../../src/delegation/registry"
import { Revocation } from "../../src/delegation/revocation"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Registry.defaultLayer, Grants.defaultLayer, Guard.defaultLayer, Revocation.defaultLayer))

let salt = ""
beforeEach(() => {
  salt = Math.random().toString(36).slice(2, 10)
})
const session = (n: number) => SessionID.make(`ses_${salt}${String(n).padStart(18, "0")}`)
const allow = (permission: string, pattern = "*") => ({ permission, pattern, action: "allow" as const })
const deny = (permission: string, pattern = "*") => ({ permission, pattern, action: "deny" as const })

const delegated = Effect.fn("test.delegated")(function* () {
  const guard = yield* Guard.Service
  const registry = yield* Registry.Service
  yield* guard.beginRun({ sessionID: session(1), agent: "build" })
  yield* guard.delegate({
    parentSessionID: session(1),
    childSessionID: session(2),
    agent: "general",
    capabilities: [allow("*"), deny("bash")],
    inherited: [],
  })
  return { guard, registry, root: (yield* registry.activeRun(session(1)))!, child: (yield* registry.activeRun(session(2)))! }
})

describe("execution audit (Phase 4 Task 8)", () => {
  it.instance("AU-02: a child run start records its typed parent run and grant", () =>
    Effect.gen(function* () {
      const { root, child } = yield* delegated()
      const started = Audit.query({ parentRunId: root.id, eventType: "run.started" })
      expect(started).toHaveLength(1)
      expect(started[0]).toMatchObject({ runId: child.id, principalId: child.principalId, grantId: child.grantId, sessionId: session(2) })
      expect(Audit.query({ grantId: child.grantId!, eventType: "grant.issued" })).toHaveLength(1)
      expect(Audit.query({ principalId: child.principalId, eventType: "principal.created" })).toHaveLength(1)
    }),
  )

  it.instance("AU-03: tool decisions are recorded with the reason and policy revision", () =>
    Effect.gen(function* () {
      const { guard, child } = yield* delegated()
      yield* guard.checkTool(session(2), "read")
      yield* guard.checkTool(session(2), "bash").pipe(Effect.ignore)
      yield* guard.checkTool(session(9), "read").pipe(Effect.ignore)
      const allowed = Audit.query({ runId: child.id, eventType: "tool.allowed" })
      expect(allowed).toHaveLength(1)
      expect(allowed[0]).toMatchObject({ tool: "read", decision: "allow", policyRevision: 0, parentRunId: child.parentRunId })
      const denied = Audit.query({ runId: child.id, eventType: "tool.denied" })
      expect(denied).toHaveLength(1)
      expect(denied[0]).toMatchObject({ tool: "bash", decision: "deny", errorCode: "layer_decision" })
      expect(Audit.query({ sessionId: session(9), eventType: "tool.denied" })[0]?.errorCode).toBe("no_run")
      // Pattern checks record denies only.
      yield* guard.checkPatterns(session(2), "read", ["/tmp/a", "/tmp/b"]).pipe(Effect.ignore)
      expect(Audit.query({ runId: child.id, eventType: "tool.allowed" })).toHaveLength(1)
    }),
  )

  it.instance("AU-05: revocation records each revoked grant and each stopped run", () =>
    Effect.gen(function* () {
      const { child } = yield* delegated()
      const revocation = yield* Revocation.Service
      yield* revocation.revokePrincipal(child.principalId, "test")
      expect(Audit.query({ principalId: child.principalId, eventType: "principal.revoked" })).toHaveLength(1)
      expect(Audit.query({ grantId: child.grantId!, eventType: "grant.revoked" })).toHaveLength(1)
      expect(Audit.query({ runId: child.id, eventType: "run.aborted" })).toHaveLength(1)
    }),
  )

  it.instance("run ends and grant expiry are recorded once", () =>
    Effect.gen(function* () {
      const { guard, child } = yield* delegated()
      const grants = yield* Grants.Service
      yield* grants.expire(child.grantId!)
      yield* grants.expire(child.grantId!)
      expect(Audit.query({ grantId: child.grantId!, eventType: "grant.expired" })).toHaveLength(1)
      yield* guard.endRun(session(2), "completed")
      yield* guard.endRun(session(2), "completed")
      expect(Audit.query({ runId: child.id, eventType: "run.ended" })).toHaveLength(1)
    }),
  )

  it.instance("records older than the retention window are pruned", () =>
    Effect.gen(function* () {
      Audit.record({ eventType: "tool.allowed", sessionId: session(1), tool: "read" })
      Database.use((db) => db.update(ExecutionAuditTable).set({ time_created: 1 }).run())
      Audit.record({ eventType: "tool.allowed", sessionId: session(1), tool: "grep" })
      expect(Audit.prune()).toBeGreaterThanOrEqual(1)
      const left = Audit.query({ sessionId: session(1) })
      expect(left.map((row) => row.tool)).toEqual(["grep"])
    }),
  )

  it.instance("a run start prunes old records at most once a day", () =>
    Effect.gen(function* () {
      const guard = yield* Guard.Service
      const old = () => {
        Audit.record({ eventType: "tool.allowed", sessionId: session(3), tool: "read" })
        Database.use((db) => db.update(ExecutionAuditTable).set({ time_created: 1 }).run())
      }
      Audit.resetPruneClock()
      old()
      yield* guard.beginRun({ sessionID: session(4), agent: "build" })
      expect(Audit.query({ sessionId: session(3) })).toHaveLength(0)
      // Within the interval a second run start does not prune again.
      old()
      yield* guard.beginRun({ sessionID: session(5), agent: "build" })
      expect(Audit.query({ sessionId: session(3) })).toHaveLength(1)
      expect(Audit.pruneIfDue(Date.now() + Audit.PRUNE_INTERVAL_MS)).toBeGreaterThanOrEqual(1)
      expect(Audit.query({ sessionId: session(3) })).toHaveLength(0)
    }),
  )
})
