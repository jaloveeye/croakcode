import { beforeEach, describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Cause, Effect, Exit, Layer } from "effect"
import { Database } from "@/storage/db"
import { DelegationGrantTable } from "../../src/delegation/delegation.sql"
import { Grants } from "../../src/delegation/grants"
import { Guard } from "../../src/delegation/guard"
import { Registry } from "../../src/delegation/registry"
import { Revocation } from "../../src/delegation/revocation"
import { GrantID, PrincipalID } from "../../src/delegation/schema"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Registry.defaultLayer, Grants.defaultLayer, Guard.defaultLayer, Revocation.defaultLayer))

let salt = ""
beforeEach(() => {
  salt = Math.random().toString(36).slice(2, 10)
})
const session = (n: number) => SessionID.make(`ses_${salt}${String(n).padStart(18, "0")}`)
const allow = (permission: string, pattern = "*") => ({ permission, pattern, action: "allow" as const })

const denied = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return "allowed"
  const err = Cause.squash(exit.cause) as { reason?: string }
  return err.reason ?? String(err)
}

// root (S1) -> child (S2) -> grandchild (S3), plus a sibling child (S4).
const tree = Effect.fn("test.tree")(function* () {
  const guard = yield* Guard.Service
  const registry = yield* Registry.Service
  const spec = (parent: number, child: number, agent: string) =>
    guard.delegate({ parentSessionID: session(parent), childSessionID: session(child), agent, capabilities: [allow("*")], inherited: [] })
  yield* guard.beginRun({ sessionID: session(1), agent: "build" })
  yield* spec(1, 2, "general")
  yield* spec(2, 3, "explore")
  yield* spec(1, 4, "general")
  const run = (n: number) => registry.activeRun(session(n)).pipe(Effect.map((r) => r!))
  return { guard, registry, root: yield* run(1), child: yield* run(2), grandchild: yield* run(3), sibling: yield* run(4) }
})

describe("revocation (Phase 4 Task 7)", () => {
  it.instance("RV-01: revoking a grant revokes every grant below it, and only those", () =>
    Effect.gen(function* () {
      const { guard, child, grandchild, sibling } = yield* tree()
      const revocation = yield* Revocation.Service
      const grants = yield* Grants.Service
      const result = yield* revocation.revokeGrant(child.grantId!, "test")
      expect(new Set(result.revokedGrants)).toEqual(new Set([child.grantId!, grandchild.grantId!]))
      expect((yield* grants.get(child.grantId!))?.status).toBe("revoked")
      expect((yield* grants.get(grandchild.grantId!))?.status).toBe("revoked")
      expect((yield* grants.get(sibling.grantId!))?.status).toBe("active")
      expect(yield* revocation.isRevoked(grandchild.grantId!)).toBe(true)
      expect(yield* revocation.isRevoked(sibling.grantId!)).toBe(false)

      // Runs under revoked grants are closed and their sessions reported for cancellation.
      expect(new Set(result.abortedRuns.map((r) => r.sessionId))).toEqual(new Set([session(2), session(3)]))
      expect(denied(yield* guard.checkTool(session(3), "read").pipe(Effect.exit))).toBe("no_run")
      expect(denied(yield* guard.checkTool(session(4), "read").pipe(Effect.exit))).toBe("allowed")
    }),
  )

  it.instance("RV-01: an expired grant keeps its status, its children are still revoked", () =>
    Effect.gen(function* () {
      const { child, grandchild } = yield* tree()
      const revocation = yield* Revocation.Service
      const grants = yield* Grants.Service
      yield* grants.expire(child.grantId!)
      const result = yield* revocation.revokeGrant(child.grantId!, "test")
      expect((yield* grants.get(child.grantId!))?.status).toBe("expired")
      expect((yield* grants.get(grandchild.grantId!))?.status).toBe("revoked")
      expect(result.revokedGrants).toEqual([grandchild.grantId!])
    }),
  )

  it.instance("revoking twice changes nothing the second time", () =>
    Effect.gen(function* () {
      const { child } = yield* tree()
      const revocation = yield* Revocation.Service
      yield* revocation.revokeGrant(child.grantId!, "first")
      const again = yield* revocation.revokeGrant(child.grantId!, "second")
      expect(again.revokedGrants).toEqual([])
      expect(again.abortedRuns).toEqual([])
      const row = Database.use((db) => db.select().from(DelegationGrantTable).where(eq(DelegationGrantTable.id, child.grantId!)).get())
      expect(row?.revoked_reason).toBe("first")
    }),
  )

  it.instance("RV-02 / AG-05: revoking a principal revokes its grants and stops its runs", () =>
    Effect.gen(function* () {
      const { guard, registry, child, grandchild, sibling } = yield* tree()
      const revocation = yield* Revocation.Service
      const result = yield* revocation.revokePrincipal(child.principalId, "test")
      expect(yield* revocation.isPrincipalRevoked(child.principalId)).toBe(true)
      // The grant it issued (to the grandchild) and the grant it holds are revoked.
      expect(new Set(result.revokedGrants)).toEqual(new Set([child.grantId!, grandchild.grantId!]))
      expect(new Set(result.abortedRuns.map((r) => r.sessionId))).toEqual(new Set([session(2), session(3)]))
      expect((yield* registry.getRun(child.id))?.status).toBe("aborted")
      expect(denied(yield* guard.checkTool(session(2), "read").pipe(Effect.exit))).toBe("no_run")
      // The sibling path is untouched.
      expect(denied(yield* guard.checkTool(session(4), "read").pipe(Effect.exit))).toBe("allowed")
      // A revoked principal cannot be resumed into a new run.
      const resume = yield* guard
        .delegate({ parentSessionID: session(1), childSessionID: session(2), agent: "general", capabilities: [allow("*")], inherited: [] })
        .pipe(Effect.exit)
      expect(denied(resume)).toBe("principal_inactive")
      void sibling
    }),
  )

  it.instance("unknown ids are reported, not ignored", () =>
    Effect.gen(function* () {
      const revocation = yield* Revocation.Service
      expect(Exit.isFailure(yield* revocation.revokeGrant(GrantID.ascending(), "x").pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* revocation.revokePrincipal(PrincipalID.ascending(), "x").pipe(Effect.exit))).toBe(true)
    }),
  )
})
