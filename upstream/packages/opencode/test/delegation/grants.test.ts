import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { Grants } from "../../src/delegation/grants"
import { Lattice } from "../../src/delegation/lattice"
import { Registry } from "../../src/delegation/registry"
import { GrantID, HUMAN_LOCAL, type GrantScope } from "../../src/delegation/schema"
import type { Permission } from "../../src/permission"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Registry.defaultLayer, Grants.defaultLayer))

const allow = (permission: string, pattern = "*") => ({ permission, pattern, action: "allow" as const })
const deny = (permission: string, pattern = "*") => ({ permission, pattern, action: "deny" as const })
const HOUR = 3_600_000
const scope: GrantScope = { paths: ["/work/project"] }
const session = (n: number) => SessionID.make(`ses_${String(n).padStart(26, "0")}`)

// Builds human -> A, with A running in session 1, and a principal B owned by A.
const chain = Effect.fn("test.chain")(function* (capabilities: Permission.Ruleset) {
  const registry = yield* Registry.Service
  const a = yield* registry.issuePrincipal({ ownerId: HUMAN_LOCAL, definition: "build", role: "orchestrator", capabilities })
  const run = yield* registry.startRun({ principalId: a.id, sessionId: session(1), policyRevision: 1 })
  const b = yield* registry.issuePrincipal({ ownerId: a.id, definition: "general", role: "developer", capabilities })
  return { registry, a, b, run }
})

const reason = <A>(exit: Exit.Exit<A, unknown>) => {
  if (Exit.isSuccess(exit)) return "issued"
  const err = Cause.squash(exit.cause) as { reason?: string }
  return err.reason ?? String(err)
}

describe("Lattice (shared with Task 4)", () => {
  test("orders actions deny < ask < allow", () => {
    expect(Lattice.stricter("allow", "ask")).toBe("ask")
    expect(Lattice.stricter("ask", "deny")).toBe("deny")
    expect(Lattice.stricter("allow", "allow")).toBe("allow")
  })

  test("finds a probe where the child is looser than the parent", () => {
    const parent = [allow("read"), deny("read", "/secret/*")]
    expect(Lattice.looserProbe([allow("read")], parent, "neutral")).toEqual({ permission: "read", pattern: "/secret/*" })
    expect(Lattice.looserProbe([allow("read"), deny("read", "/secret/*")], parent, "neutral")).toBeUndefined()
    // A permission wildcard in the child is caught by the parent's specific deny.
    expect(Lattice.looserProbe([allow("*")], [allow("*"), deny("bash")], "neutral")).toEqual({ permission: "bash", pattern: "*" })
  })
})

describe("layer semantics (Phase 4 Task 5)", () => {
  test("a grant is an allow-list; a restriction layer only restricts", () => {
    expect(Lattice.decideLayer("bash", "ls", [allow("read")], "deny")).toBe("deny")
    expect(Lattice.decideLayer("bash", "ls", [deny("edit")], "neutral")).toBe("allow")
    expect(Lattice.decideLayer("edit", "x", [deny("edit")], "neutral")).toBe("deny")
  })

  test("a point the parent grant does not name cannot be delegated further", () => {
    expect(Lattice.looserProbe([allow("edit")], [allow("read")], "deny")).toEqual({ permission: "edit", pattern: "*" })
    expect(Lattice.looserProbe([allow("edit")], [allow("read")], "neutral")).toBeUndefined()
    // Asking is not denying: a delegator's "ask" does not block a grant.
    expect(Lattice.looserProbe([allow("*")], [{ permission: "external_directory", pattern: "*", action: "ask" as const }], "neutral")).toBeUndefined()
  })
})

describe("Delegation Store (Phase 4 Task 3)", () => {
  it.instance("issues a root grant within the delegator's capabilities and scope", () =>
    Effect.gen(function* () {
      const { a, b, run } = yield* chain([allow("read"), allow("edit")])
      const grants = yield* Grants.Service
      const grant = yield* grants.issue({
        delegatorPrincipalId: a.id,
        delegateePrincipalId: b.id,
        parentRunId: run.id,
        capabilities: [allow("read")],
        scope,
        bound: scope,
        constraints: [],
        expiresAt: Date.now() + HOUR,
        policyRevision: 1,
      })
      expect(grant.id.startsWith("grt")).toBe(true)
      expect(grant.depth).toBe(1)
      expect(grant.status).toBe("active")
      expect(yield* grants.get(grant.id)).toEqual(grant)
      expect((yield* grants.listByDelegatee(b.id)).map((g) => g.id)).toEqual([grant.id])
    }),
  )

  it.instance("DG-02: a grant cannot carry a capability the delegator lacks", () =>
    Effect.gen(function* () {
      const { a, b, run } = yield* chain([allow("read"), deny("bash")])
      const grants = yield* Grants.Service
      const exit = yield* grants
        .issue({
          delegatorPrincipalId: a.id,
          delegateePrincipalId: b.id,
          parentRunId: run.id,
          capabilities: [allow("*")],
          scope,
          bound: scope,
          constraints: [],
          expiresAt: Date.now() + HOUR,
          policyRevision: 1,
        })
        .pipe(Effect.exit)
      expect(reason(exit)).toBe("capability_escalation")
    }),
  )

  it.instance("DG-02: a sub-grant cannot exceed its parent grant", () =>
    Effect.gen(function* () {
      const { registry, a, b, run } = yield* chain([allow("*")])
      const grants = yield* Grants.Service
      const parent = yield* grants.issue({
        delegatorPrincipalId: a.id,
        delegateePrincipalId: b.id,
        parentRunId: run.id,
        capabilities: [allow("read")],
        scope,
        bound: scope,
        constraints: [],
        expiresAt: Date.now() + HOUR,
        policyRevision: 1,
      })
      const bRun = yield* registry.startRun({ principalId: b.id, sessionId: session(2), parentRunId: run.id, grantId: parent.id, policyRevision: 1 })
      const c = yield* registry.issuePrincipal({ ownerId: b.id, definition: "explore", role: "test", capabilities: [allow("*")] })
      const exit = yield* grants
        .issue({
          delegatorPrincipalId: b.id,
          delegateePrincipalId: c.id,
          parentGrantId: parent.id,
          parentRunId: bRun.id,
          capabilities: [allow("read"), allow("edit")],
          scope,
          constraints: [],
          expiresAt: Date.now() + HOUR,
          policyRevision: 1,
        })
        .pipe(Effect.exit)
      expect(reason(exit)).toBe("capability_escalation")
    }),
  )

  it.instance("DG-03: scope may only narrow and constraints may only grow", () =>
    Effect.gen(function* () {
      const { a, b, run } = yield* chain([allow("*")])
      const grants = yield* Grants.Service
      const base = {
        delegatorPrincipalId: a.id,
        delegateePrincipalId: b.id,
        parentRunId: run.id,
        capabilities: [allow("read")],
        bound: scope,
        expiresAt: Date.now() + HOUR,
        policyRevision: 1,
      }
      const wider = yield* grants.issue({ ...base, scope: { paths: ["/work"] }, constraints: [] }).pipe(Effect.exit)
      expect(reason(wider)).toBe("scope_escalation")
      const sibling = yield* grants.issue({ ...base, scope: { paths: ["/work/project-other"] }, constraints: [] }).pipe(Effect.exit)
      expect(reason(sibling)).toBe("scope_escalation")
      const relative = yield* grants.issue({ ...base, scope: { paths: ["project"] }, constraints: [] }).pipe(Effect.exit)
      expect(reason(relative)).toBe("scope_escalation")
      const narrower = yield* grants.issue({ ...base, scope: { paths: ["/work/project/src"] }, constraints: [{ kind: "tools", value: ["read"] }] })
      expect(narrower.scope.paths).toEqual(["/work/project/src"])

      const registry = yield* Registry.Service
      const bRun = yield* registry.startRun({ principalId: b.id, sessionId: session(2), parentRunId: run.id, grantId: narrower.id, policyRevision: 1 })
      const c = yield* registry.issuePrincipal({ ownerId: b.id, definition: "explore", role: "test", capabilities: [allow("*")] })
      const dropped = yield* grants
        .issue({
          delegatorPrincipalId: b.id,
          delegateePrincipalId: c.id,
          parentGrantId: narrower.id,
          parentRunId: bRun.id,
          capabilities: [allow("read")],
          scope: { paths: ["/work/project/src"] },
          constraints: [],
          expiresAt: Date.now() + HOUR,
          policyRevision: 1,
        })
        .pipe(Effect.exit)
      expect(reason(dropped)).toBe("constraint_weakened")
    }),
  )

  it.instance("DG-04: expiry may not extend and policy revision may not go back", () =>
    Effect.gen(function* () {
      const { registry, a, b, run } = yield* chain([allow("*")])
      const grants = yield* Grants.Service
      const parent = yield* grants.issue({
        delegatorPrincipalId: a.id,
        delegateePrincipalId: b.id,
        parentRunId: run.id,
        capabilities: [allow("read")],
        scope,
        bound: scope,
        constraints: [],
        expiresAt: Date.now() + HOUR,
        policyRevision: 2,
      })
      const bRun = yield* registry.startRun({ principalId: b.id, sessionId: session(2), parentRunId: run.id, grantId: parent.id, policyRevision: 2 })
      const c = yield* registry.issuePrincipal({ ownerId: b.id, definition: "explore", role: "test", capabilities: [allow("*")] })
      const base = {
        delegatorPrincipalId: b.id,
        delegateePrincipalId: c.id,
        parentGrantId: parent.id,
        parentRunId: bRun.id,
        capabilities: [allow("read")],
        scope,
        constraints: [],
      }
      expect(reason(yield* grants.issue({ ...base, expiresAt: parent.expiresAt + 1, policyRevision: 2 }).pipe(Effect.exit))).toBe("expiry_extended")
      expect(reason(yield* grants.issue({ ...base, expiresAt: Date.now() - 1, policyRevision: 2 }).pipe(Effect.exit))).toBe("expired")
      expect(reason(yield* grants.issue({ ...base, expiresAt: parent.expiresAt, policyRevision: 1 }).pipe(Effect.exit))).toBe("revision_regressed")
      const ok = yield* grants.issue({ ...base, expiresAt: parent.expiresAt, policyRevision: 3 })
      expect(ok.depth).toBe(2)
      expect((yield* grants.listChain(ok.id)).map((g) => g.id)).toEqual([ok.id, parent.id])
    }),
  )

  it.instance("DG-04: a principal cannot appear twice in one delegation chain", () =>
    Effect.gen(function* () {
      const { registry, a, b, run } = yield* chain([allow("*")])
      const grants = yield* Grants.Service
      const ab = yield* grants.issue({
        delegatorPrincipalId: a.id,
        delegateePrincipalId: b.id,
        parentRunId: run.id,
        capabilities: [allow("read")],
        scope,
        bound: scope,
        constraints: [],
        expiresAt: Date.now() + HOUR,
        policyRevision: 1,
      })
      const bRun = yield* registry.startRun({ principalId: b.id, sessionId: session(2), parentRunId: run.id, grantId: ab.id, policyRevision: 1 })
      const back = yield* grants
        .issue({
          delegatorPrincipalId: b.id,
          delegateePrincipalId: a.id,
          parentGrantId: ab.id,
          parentRunId: bRun.id,
          capabilities: [allow("read")],
          scope,
          constraints: [],
          expiresAt: ab.expiresAt,
          policyRevision: 1,
        })
        .pipe(Effect.exit)
      expect(reason(back)).toBe("cycle")
      const self = yield* grants
        .issue({
          delegatorPrincipalId: a.id,
          delegateePrincipalId: a.id,
          parentRunId: run.id,
          capabilities: [allow("read")],
          scope,
          bound: scope,
          constraints: [],
          expiresAt: Date.now() + HOUR,
          policyRevision: 1,
        })
        .pipe(Effect.exit)
      expect(reason(self)).toBe("cycle")
    }),
  )

  it.instance("depth is limited to 3 (Phase 4 decision 7)", () =>
    Effect.gen(function* () {
      const registry = yield* Registry.Service
      const grants = yield* Grants.Service
      const caps = [allow("read")]
      let owner = yield* registry.issuePrincipal({ ownerId: HUMAN_LOCAL, definition: "build", role: "r0", capabilities: caps })
      let run = yield* registry.startRun({ principalId: owner.id, sessionId: session(10), policyRevision: 1 })
      let parentGrantId: GrantID | undefined
      const expiresAt = Date.now() + HOUR
      for (let depth = 1; depth <= 4; depth++) {
        const next = yield* registry.issuePrincipal({ ownerId: owner.id, definition: "general", role: `r${depth}`, capabilities: caps })
        const exit = yield* grants
          .issue({
            delegatorPrincipalId: owner.id,
            delegateePrincipalId: next.id,
            ...(parentGrantId ? { parentGrantId } : { bound: scope }),
            parentRunId: run.id,
            capabilities: caps,
            scope,
            constraints: [],
            expiresAt,
            policyRevision: 1,
          })
          .pipe(Effect.exit)
        if (depth <= 3) {
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isFailure(exit)) return
          parentGrantId = exit.value.id
          run = yield* registry.startRun({ principalId: next.id, sessionId: session(10 + depth), parentRunId: run.id, grantId: parentGrantId, policyRevision: 1 })
          owner = next
        } else {
          expect(reason(exit)).toBe("depth_exceeded")
        }
      }
    }),
  )

  it.instance("a lower configured depth limit applies; a higher one does not", () =>
    Effect.gen(function* () {
      expect(Grants.effectiveMaxDepth(undefined)).toBe(3)
      expect(Grants.effectiveMaxDepth(2)).toBe(2)
      expect(Grants.effectiveMaxDepth(9)).toBe(3)
      expect(Grants.effectiveMaxDepth(0)).toBe(0)
    }),
  )

  it.instance("only the holder of the parent grant can sub-delegate, from its own run", () =>
    Effect.gen(function* () {
      const { registry, a, b, run } = yield* chain([allow("*")])
      const grants = yield* Grants.Service
      const ab = yield* grants.issue({
        delegatorPrincipalId: a.id,
        delegateePrincipalId: b.id,
        parentRunId: run.id,
        capabilities: [allow("read")],
        scope,
        bound: scope,
        constraints: [],
        expiresAt: Date.now() + HOUR,
        policyRevision: 1,
      })
      const c = yield* registry.issuePrincipal({ ownerId: a.id, definition: "explore", role: "test", capabilities: [allow("*")] })
      // A did not receive ab; only B can delegate under it.
      const notHolder = yield* grants
        .issue({
          delegatorPrincipalId: a.id,
          delegateePrincipalId: c.id,
          parentGrantId: ab.id,
          parentRunId: run.id,
          capabilities: [allow("read")],
          scope,
          constraints: [],
          expiresAt: ab.expiresAt,
          policyRevision: 1,
        })
        .pipe(Effect.exit)
      expect(reason(notHolder)).toBe("delegator_mismatch")
      // B must delegate from a run of its own.
      const foreignRun = yield* grants
        .issue({
          delegatorPrincipalId: b.id,
          delegateePrincipalId: c.id,
          parentGrantId: ab.id,
          parentRunId: run.id,
          capabilities: [allow("read")],
          scope,
          constraints: [],
          expiresAt: ab.expiresAt,
          policyRevision: 1,
        })
        .pipe(Effect.exit)
      expect(reason(foreignRun)).toBe("run_mismatch")
    }),
  )

  it.instance("a root grant needs an explicit scope bound", () =>
    Effect.gen(function* () {
      const { a, b, run } = yield* chain([allow("*")])
      const grants = yield* Grants.Service
      const exit = yield* grants
        .issue({
          delegatorPrincipalId: a.id,
          delegateePrincipalId: b.id,
          parentRunId: run.id,
          capabilities: [allow("read")],
          scope,
          constraints: [],
          expiresAt: Date.now() + HOUR,
          policyRevision: 1,
        })
        .pipe(Effect.exit)
      expect(reason(exit)).toBe("scope_escalation")
    }),
  )

  it.instance("revoked or expired parents block sub-delegation; expire() records expiry", () =>
    Effect.gen(function* () {
      const { registry, a, b, run } = yield* chain([allow("*")])
      const grants = yield* Grants.Service
      const ab = yield* grants.issue({
        delegatorPrincipalId: a.id,
        delegateePrincipalId: b.id,
        parentRunId: run.id,
        capabilities: [allow("read")],
        scope,
        bound: scope,
        constraints: [],
        expiresAt: Date.now() + HOUR,
        policyRevision: 1,
      })
      const bRun = yield* registry.startRun({ principalId: b.id, sessionId: session(2), parentRunId: run.id, grantId: ab.id, policyRevision: 1 })
      const c = yield* registry.issuePrincipal({ ownerId: b.id, definition: "explore", role: "test", capabilities: [allow("*")] })
      yield* grants.expire(ab.id)
      expect((yield* grants.get(ab.id))?.status).toBe("expired")
      const exit = yield* grants
        .issue({
          delegatorPrincipalId: b.id,
          delegateePrincipalId: c.id,
          parentGrantId: ab.id,
          parentRunId: bRun.id,
          capabilities: [allow("read")],
          scope,
          constraints: [],
          expiresAt: ab.expiresAt,
          policyRevision: 1,
        })
        .pipe(Effect.exit)
      expect(reason(exit)).toBe("parent_inactive")
    }),
  )

  it.instance("the task-tool grant shape (allow * plus denies) issues at depth 2", () =>
    Effect.gen(function* () {
      const registry = yield* Registry.Service
      const grants = yield* Grants.Service
      const agentRules = [allow("*"), { permission: "external_directory", pattern: "*", action: "ask" as const }, deny("edit")]
      const a = yield* registry.issuePrincipal({ ownerId: HUMAN_LOCAL, definition: "build", role: "root", capabilities: [allow("*")] })
      const aRun = yield* registry.startRun({ principalId: a.id, sessionId: session(1), policyRevision: 0 })
      const b = yield* registry.issuePrincipal({ ownerId: a.id, definition: "plan", role: "plan", capabilities: agentRules })
      const ab = yield* grants.issue({
        delegatorPrincipalId: a.id,
        delegateePrincipalId: b.id,
        parentRunId: aRun.id,
        capabilities: Grants.delegationCapabilities({ delegator: a.capabilities, inherited: [] }),
        scope,
        bound: scope,
        constraints: [],
        expiresAt: Date.now() + HOUR,
        policyRevision: 0,
      })
      const bRun = yield* registry.startRun({ principalId: b.id, sessionId: session(2), parentRunId: aRun.id, grantId: ab.id, policyRevision: 0 })
      const c = yield* registry.issuePrincipal({ ownerId: b.id, definition: "general", role: "general", capabilities: [allow("*")] })
      const bc = yield* grants.issue({
        delegatorPrincipalId: b.id,
        delegateePrincipalId: c.id,
        parentGrantId: ab.id,
        parentRunId: bRun.id,
        capabilities: Grants.delegationCapabilities({ delegator: b.capabilities, parent: ab.capabilities, inherited: [deny("todowrite")] }),
        scope,
        constraints: [],
        expiresAt: ab.expiresAt,
        policyRevision: 0,
      })
      expect(bc.depth).toBe(2)
      // B's edit deny travels into the grant.
      expect(Lattice.decideLayer("edit", "x", bc.capabilities, "deny")).toBe("deny")
      expect(Lattice.decideLayer("todowrite", "*", bc.capabilities, "deny")).toBe("deny")
      expect(Lattice.decideLayer("read", "x", bc.capabilities, "deny")).toBe("allow")
    }),
  )
})
