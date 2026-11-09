import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { ServerAuth } from "../../src/server/auth"
import { Grants } from "../../src/delegation/grants"
import { Registry } from "../../src/delegation/registry"
import { GrantID, HUMAN_LOCAL } from "../../src/delegation/schema"
import { SessionID } from "../../src/session/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import * as Log from "@croakcode/core/util/log"

void Log.init({ print: false })

function app(password?: string) {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ CROAKCODE_SERVER_PASSWORD: password })))),
    { disableLogger: true },
  ).handler
  return (path: string, headers: Record<string, string>) =>
    handler(
      new Request(new URL(path, "http://localhost"), {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ reason: "test" }),
      }),
      HttpApiApp.context,
    )
}

const auth = (password: string) => ({ authorization: ServerAuth.header({ username: "croakcode", password }) ?? "" })

const seed = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* Registry.Service
      const grants = yield* Grants.Service
      const allow = [{ permission: "*", pattern: "*", action: "allow" as const }]
      const root = yield* registry.issuePrincipal({ ownerId: HUMAN_LOCAL, definition: "build", role: "root", capabilities: allow })
      const run = yield* registry.startRun({ principalId: root.id, sessionId: SessionID.make("ses_httpapidelegation00000001"), policyRevision: 0 })
      const child = yield* registry.issuePrincipal({ ownerId: root.id, definition: "general", role: "general", capabilities: allow })
      const grant = yield* grants.issue({
        delegatorPrincipalId: root.id,
        delegateePrincipalId: child.id,
        parentRunId: run.id,
        capabilities: allow,
        scope: { paths: ["/tmp"] },
        bound: { paths: ["/tmp"] },
        constraints: [],
        expiresAt: Date.now() + 60_000,
        policyRevision: 0,
      })
      return { child, grant }
    }).pipe(Effect.provide(Layer.mergeAll(Registry.defaultLayer, Grants.defaultLayer))),
  )

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi delegation revocation (Phase 4 Task 7)", () => {
  test("refuses when no server password is configured", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const post = app(undefined)
    const res = await post(`/delegation/grant/${GrantID.ascending()}/revoke`, { "x-opencode-directory": tmp.path })
    expect(res.status).toBe(403)
  })

  test("requires authorization when a password is configured", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const post = app("secret")
    const res = await post(`/delegation/grant/${GrantID.ascending()}/revoke`, { "x-opencode-directory": tmp.path })
    expect(res.status).toBe(401)
  })

  test("reports an unknown grant as not found", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const post = app("secret")
    const res = await post(`/delegation/grant/${GrantID.ascending()}/revoke`, { "x-opencode-directory": tmp.path, ...auth("secret") })
    expect(res.status).toBe(404)
  })

  test("revokes a grant and a principal", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const { child, grant } = await seed()
    const post = app("secret")
    const headers = { "x-opencode-directory": tmp.path, ...auth("secret") }

    const byGrant = await post(`/delegation/grant/${grant.id}/revoke`, headers)
    expect(byGrant.status).toBe(200)
    expect((await byGrant.json()).revokedGrants).toEqual([grant.id])

    const byPrincipal = await post(`/delegation/principal/${child.id}/revoke`, headers)
    expect(byPrincipal.status).toBe(200)
    const principal = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Registry.Service).getPrincipal(child.id)
      }).pipe(Effect.provide(Registry.defaultLayer)),
    )
    expect(principal?.status).toBe("revoked")
  })
})
