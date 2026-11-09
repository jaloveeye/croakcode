import { afterEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@/storage/db"
import { DelegationGrantTable } from "../../src/delegation/delegation.sql"
import { Effective } from "../../src/delegation/effective"
import { Grants } from "../../src/delegation/grants"
import { Policy } from "../../src/delegation/policy"
import { Registry } from "../../src/delegation/registry"
import { HUMAN_LOCAL, type GrantScope } from "../../src/delegation/schema"
import type { Permission } from "../../src/permission"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Registry.defaultLayer, Grants.defaultLayer, Effective.defaultLayer))

const allow = (permission: string, pattern = "*") => ({ permission, pattern, action: "allow" as const })
const deny = (permission: string, pattern = "*") => ({ permission, pattern, action: "deny" as const })
const HOUR = 3_600_000
const scope: GrantScope = { paths: ["/work/project"] }
const session = (n: number) => SessionID.make(`ses_${String(n).padStart(26, "0")}`)
const KEY = "test-admin-policy-key"

const saved = { file: process.env.CROAKCODE_ADMIN_POLICY_FILE, key: process.env.CROAKCODE_ADMIN_POLICY_KEY }
afterEach(() => {
  if (saved.file === undefined) delete process.env.CROAKCODE_ADMIN_POLICY_FILE
  else process.env.CROAKCODE_ADMIN_POLICY_FILE = saved.file
  if (saved.key === undefined) delete process.env.CROAKCODE_ADMIN_POLICY_KEY
  else process.env.CROAKCODE_ADMIN_POLICY_KEY = saved.key
})

function writePolicy(body: unknown, opts?: { signWith?: string; raw?: string }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "croak-policy-"))
  const file = path.join(dir, "policy.json")
  const text = opts?.raw ?? JSON.stringify(body)
  writeFileSync(file, text)
  writeFileSync(`${file}.sig`, createHmac("sha256", opts?.signWith ?? KEY).update(text).digest("hex"))
  process.env.CROAKCODE_ADMIN_POLICY_FILE = file
  process.env.CROAKCODE_ADMIN_POLICY_KEY = KEY
  return file
}

// human -> A (root, running in session 1) -> B via grant, B running in session 2.
const delegated = Effect.fn("test.delegated")(function* (input: {
  a: Permission.Ruleset
  b: Permission.Ruleset
  grant: Permission.Ruleset
  grantScope?: GrantScope
}) {
  const registry = yield* Registry.Service
  const grants = yield* Grants.Service
  const a = yield* registry.issuePrincipal({ ownerId: HUMAN_LOCAL, definition: "build", role: "orchestrator", capabilities: input.a })
  const aRun = yield* registry.startRun({ principalId: a.id, sessionId: session(1), policyRevision: 0 })
  const b = yield* registry.issuePrincipal({ ownerId: a.id, definition: "general", role: "developer", capabilities: input.b })
  const grant = yield* grants.issue({
    delegatorPrincipalId: a.id,
    delegateePrincipalId: b.id,
    parentRunId: aRun.id,
    capabilities: input.grant,
    scope: input.grantScope ?? scope,
    bound: scope,
    constraints: [],
    expiresAt: Date.now() + HOUR,
    policyRevision: 0,
  })
  const bRun = yield* registry.startRun({ principalId: b.id, sessionId: session(2), parentRunId: aRun.id, grantId: grant.id, policyRevision: 0 })
  return { registry, grants, a, aRun, b, bRun, grant }
})

describe("admin policy loader", () => {
  test("no policy file means no organisation limit at revision 0", () => {
    delete process.env.CROAKCODE_ADMIN_POLICY_FILE
    expect(Policy.load()).toEqual({ status: "none", revision: 0 })
  })

  test("a correctly signed policy loads", () => {
    writePolicy({ revision: 4, rules: [deny("bash")], maxDelegationDepth: 2 })
    const policy = Policy.load()
    expect(policy.status).toBe("valid")
    if (policy.status !== "valid") return
    expect(policy.revision).toBe(4)
    expect(policy.rules).toEqual([deny("bash")])
    expect(policy.maxDelegationDepth).toBe(2)
  })

  test("a configured policy that cannot be verified is invalid", () => {
    writePolicy({ revision: 1, rules: [] }, { signWith: "wrong-key" })
    expect(Policy.load().status).toBe("invalid")
    writePolicy(undefined, { raw: "not json" })
    expect(Policy.load().status).toBe("invalid")
    writePolicy({ revision: -1, rules: [] })
    expect(Policy.load().status).toBe("invalid")
    writePolicy({ revision: 1, rules: [] })
    delete process.env.CROAKCODE_ADMIN_POLICY_KEY
    expect(Policy.load().status).toBe("invalid")
    process.env.CROAKCODE_ADMIN_POLICY_KEY = ""
    expect(Policy.load().status).toBe("invalid")
    process.env.CROAKCODE_ADMIN_POLICY_FILE = "/nonexistent/croak-policy.json"
    process.env.CROAKCODE_ADMIN_POLICY_KEY = KEY
    expect(Policy.load().status).toBe("invalid")
  })

  test("HMAC verification matches control/src/admin-policy.mjs", () => {
    const body = JSON.stringify({ revision: 1 })
    const signature = createHmac("sha256", KEY).update(body).digest("hex")
    expect(Policy.verify(body, signature, KEY)).toBe(true)
    expect(Policy.verify(body + " ", signature, KEY)).toBe(false)
    expect(Policy.verify(body, signature, "")).toBe(false)
    expect(Policy.verify(body, "zz", KEY)).toBe(false)
  })
})

describe("effective authorization (Phase 4 Task 4)", () => {
  it.instance("a root principal is limited by its own capabilities", () =>
    Effect.gen(function* () {
      delete process.env.CROAKCODE_ADMIN_POLICY_FILE
      const registry = yield* Registry.Service
      const effective = yield* Effective.Service
      const a = yield* registry.issuePrincipal({ ownerId: HUMAN_LOCAL, definition: "build", role: "r", capabilities: [allow("*"), deny("bash")] })
      const run = yield* registry.startRun({ principalId: a.id, sessionId: session(1), policyRevision: 0 })
      expect((yield* effective.decide({ runId: run.id, permission: "read", pattern: "*" })).action).toBe("allow")
      const bash = yield* effective.decide({ runId: run.id, permission: "bash", pattern: "ls" })
      expect(bash.action).toBe("deny")
      expect(bash.layer).toBe("principal")
    }),
  )

  it.instance("DG-05: a sub-agent never exceeds its parent run, its grant or its own policy", () =>
    Effect.gen(function* () {
      delete process.env.CROAKCODE_ADMIN_POLICY_FILE
      const { bRun, grant } = yield* delegated({
        a: [allow("*"), deny("edit")],
        b: [allow("*"), deny("webfetch")],
        grant: [allow("read"), allow("grep")],
      })
      // Model a grant wider than its source that got past issuance (the
      // issuance guard does not enumerate every wildcard overlap). The
      // execution-time intersection must still hold.
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(DelegationGrantTable)
            .set({ capabilities: [allow("read"), allow("edit"), allow("webfetch"), allow("grep")] })
            .where(eq(DelegationGrantTable.id, grant.id))
            .run(),
        ),
      )
      const effective = yield* Effective.Service
      const decide = (permission: string) => effective.decide({ runId: bRun.id, permission, pattern: "*" })
      // Parent run (A) denies edit; the grant cannot lift it.
      expect((yield* decide("edit")).action).toBe("deny")
      // B's own policy denies webfetch.
      expect((yield* decide("webfetch")).action).toBe("deny")
      // Allowed by every layer.
      expect((yield* decide("read")).action).toBe("allow")
      // The grant never mentions bash: the grant layer decides "ask", so the
      // result cannot be allow even though A and B allow everything.
      expect((yield* decide("bash")).action).not.toBe("allow")
    }),
  )

  it.instance("DG-05: the organisation policy caps every layer and is re-read on each decision", () =>
    Effect.gen(function* () {
      const { bRun } = yield* delegated({ a: [allow("*")], b: [allow("*")], grant: [allow("*")] })
      const effective = yield* Effective.Service
      delete process.env.CROAKCODE_ADMIN_POLICY_FILE
      expect((yield* effective.decide({ runId: bRun.id, permission: "bash", pattern: "ls" })).action).toBe("allow")
      // The policy narrows after the grant was issued: the existing grant narrows too.
      writePolicy({ revision: 1, rules: [allow("*"), deny("bash")] })
      const narrowed = yield* effective.decide({ runId: bRun.id, permission: "bash", pattern: "ls" })
      expect(narrowed.action).toBe("deny")
      expect(narrowed.layer).toBe("organisation")
      expect(narrowed.policyRevision).toBe(1)
      // A wider policy never lifts the grant.
      writePolicy({ revision: 2, rules: [allow("*")] })
      expect((yield* effective.decide({ runId: bRun.id, permission: "bash", pattern: "ls" })).action).toBe("allow")
      // A configured policy that fails verification denies everything.
      writePolicy({ revision: 3, rules: [allow("*")] }, { signWith: "forged" })
      const invalid = yield* effective.decide({ runId: bRun.id, permission: "read", pattern: "*" })
      expect(invalid.action).toBe("deny")
      expect(invalid.reason).toBe("policy_invalid")
    }),
  )

  it.instance("DG-06: several delegation paths intersect; they never union", () =>
    Effect.gen(function* () {
      delete process.env.CROAKCODE_ADMIN_POLICY_FILE
      const { registry, grants, b } = yield* delegated({
        a: [allow("*")],
        b: [allow("*")],
        grant: [allow("read"), deny("bash")],
      })
      // A second root principal R grants B bash as well.
      const r = yield* registry.issuePrincipal({ ownerId: HUMAN_LOCAL, definition: "build", role: "r", capabilities: [allow("*")] })
      const rRun = yield* registry.startRun({ principalId: r.id, sessionId: session(3), policyRevision: 0 })
      const second = yield* grants.issue({
        delegatorPrincipalId: r.id,
        delegateePrincipalId: b.id,
        parentRunId: rRun.id,
        capabilities: [allow("read"), allow("bash")],
        scope,
        bound: scope,
        constraints: [],
        expiresAt: Date.now() + HOUR,
        policyRevision: 0,
      })
      const viaSecond = yield* registry.startRun({ principalId: b.id, sessionId: session(4), parentRunId: rRun.id, grantId: second.id, policyRevision: 0 })
      const effective = yield* Effective.Service
      const bash = yield* effective.decide({ runId: viaSecond.id, permission: "bash", pattern: "ls" })
      expect(bash.action).toBe("deny")
      expect((yield* effective.decide({ runId: viaSecond.id, permission: "read", pattern: "*" })).action).toBe("allow")

      // Revoking the grant this run started under denies it, even though the
      // principal still holds an active grant on the other path.
      yield* Effect.sync(() =>
        Database.use((db) =>
          db.update(DelegationGrantTable).set({ status: "revoked" }).where(eq(DelegationGrantTable.id, second.id)).run(),
        ),
      )
      const revoked = yield* effective.decide({ runId: viaSecond.id, permission: "read", pattern: "*" })
      expect(revoked.action).toBe("deny")
      expect(revoked.reason).toBe("grant_inactive")
    }),
  )

  it.instance("a principal with no grant that is not a root gets nothing (INV-5.4)", () =>
    Effect.gen(function* () {
      delete process.env.CROAKCODE_ADMIN_POLICY_FILE
      const registry = yield* Registry.Service
      const effective = yield* Effective.Service
      const a = yield* registry.issuePrincipal({ ownerId: HUMAN_LOCAL, definition: "build", role: "r", capabilities: [allow("*")] })
      const aRun = yield* registry.startRun({ principalId: a.id, sessionId: session(1), policyRevision: 0 })
      const orphan = yield* registry.issuePrincipal({ ownerId: a.id, definition: "general", role: "x", capabilities: [allow("*")] })
      const run = yield* registry.startRun({ principalId: orphan.id, sessionId: session(2), parentRunId: aRun.id, policyRevision: 0 })
      const result = yield* effective.decide({ runId: run.id, permission: "read", pattern: "*" })
      expect(result.action).toBe("deny")
      expect(result.reason).toBe("no_grant")
    }),
  )

  it.instance("revoked principals, ended runs, unknown runs and expired grants are denied", () =>
    Effect.gen(function* () {
      delete process.env.CROAKCODE_ADMIN_POLICY_FILE
      const { registry, grants, a, aRun, bRun, grant } = yield* delegated({ a: [allow("*")], b: [allow("*")], grant: [allow("*")] })
      const effective = yield* Effective.Service
      const read = (runId: typeof bRun.id) => effective.decide({ runId, permission: "read", pattern: "*" })
      expect((yield* read(bRun.id)).action).toBe("allow")

      // Expired grant: detected at decision time and recorded.
      yield* Effect.sync(() =>
        Database.use((db) =>
          db.update(DelegationGrantTable).set({ expires_at: Date.now() - 1 }).where(eq(DelegationGrantTable.id, grant.id)).run(),
        ),
      )
      const expired = yield* read(bRun.id)
      expect(expired.action).toBe("deny")
      expect(expired.reason).toBe("grant_inactive")
      expect((yield* grants.get(grant.id))?.status).toBe("expired")

      const unknown = yield* effective.decide({ runId: "run_00000000000000000000000000" as typeof bRun.id, permission: "read", pattern: "*" })
      expect(unknown.reason).toBe("run_inactive")

      yield* registry.revokePrincipal(a.id, "test")
      expect((yield* read(aRun.id)).reason).toBe("principal_inactive")
      yield* registry.endRun(bRun.id, "completed")
      expect((yield* read(bRun.id)).reason).toBe("run_inactive")
    }),
  )

  it.instance("paths outside every grant scope are denied", () =>
    Effect.gen(function* () {
      delete process.env.CROAKCODE_ADMIN_POLICY_FILE
      const { bRun } = yield* delegated({
        a: [allow("*")],
        b: [allow("*")],
        grant: [allow("*")],
        grantScope: { paths: ["/work/project/src"] },
      })
      const effective = yield* Effective.Service
      const inside = yield* effective.decide({ runId: bRun.id, permission: "read", pattern: "*", path: "/work/project/src/a.ts" })
      expect(inside.action).toBe("allow")
      const outside = yield* effective.decide({ runId: bRun.id, permission: "read", pattern: "*", path: "/work/project/secret.env" })
      expect(outside.action).toBe("deny")
      expect(outside.reason).toBe("out_of_scope")
      const relative = yield* effective.decide({ runId: bRun.id, permission: "read", pattern: "*", path: "src/a.ts" })
      expect(relative.action).toBe("deny")
    }),
  )

  it.instance("a tool-level check does not let a path-scoped grant rule deny the whole tool", () =>
    Effect.gen(function* () {
      delete process.env.CROAKCODE_ADMIN_POLICY_FILE
      const { bRun } = yield* delegated({
        a: [allow("*")],
        b: [allow("*")],
        grant: [allow("read", "/work/project/*")],
      })
      const effective = yield* Effective.Service
      const tool = (permission: string) => effective.decide({ runId: bRun.id, permission, pattern: "*", toolLevel: true })
      expect((yield* tool("read")).action).toBe("allow")
      expect((yield* tool("bash")).action).toBe("deny")
      const outside = yield* effective.decide({ runId: bRun.id, permission: "read", pattern: "/etc/passwd" })
      expect(outside.action).toBe("deny")
      const inside = yield* effective.decide({ runId: bRun.id, permission: "read", pattern: "/work/project/a.ts" })
      expect(inside.action).toBe("allow")
    }),
  )

  it.instance("an organisation policy that names nothing about a tool does not block it", () =>
    Effect.gen(function* () {
      writePolicy({ revision: 1, rules: [deny("webfetch")] })
      const registry = yield* Registry.Service
      const effective = yield* Effective.Service
      const a = yield* registry.issuePrincipal({ ownerId: HUMAN_LOCAL, definition: "build", role: "r", capabilities: [allow("*")] })
      const run = yield* registry.startRun({ principalId: a.id, sessionId: session(1), policyRevision: 1 })
      expect((yield* effective.decide({ runId: run.id, permission: "read", pattern: "*" })).action).toBe("allow")
      expect((yield* effective.decide({ runId: run.id, permission: "webfetch", pattern: "x" })).action).toBe("deny")
    }),
  )
})
