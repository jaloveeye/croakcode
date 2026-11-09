import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { Audit } from "../../src/delegation/audit"
import { Effective } from "../../src/delegation/effective"
import { Grants } from "../../src/delegation/grants"
import { Guard } from "../../src/delegation/guard"
import { Permit } from "../../src/delegation/permit"
import { PermitClient } from "../../src/delegation/permit-client"
import { Registry } from "../../src/delegation/registry"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const gate = generateKeyPairSync("ed25519")
const forger = generateKeyPairSync("ed25519")
const rawPublic = gate.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64")

// How the fake Gate answers the next request.
let mode: "sign" | "forge" | "wrong-args" | "replay" | "down" = "sign"
let last: string | undefined
let seen: PermitClient.PermitRequest[] = []

function mint(body: PermitClient.PermitRequest, key = gate.privateKey) {
  const now = Date.now()
  const segment = Permit.encodePayload({ aud: "croakcode", ...body, iat: now, exp: now + 30_000, nonce: Math.random().toString(36).slice(2) })
  return Permit.joinToken(segment, sign(null, Buffer.from(segment, "ascii"), key))
}

const fakeGate = Layer.succeed(
  PermitClient.Service,
  PermitClient.Service.of({
    request: (_url, body) =>
      Effect.gen(function* () {
        seen.push(body)
        if (mode === "down") return yield* new PermitClient.PermitRequestError({ reason: "unreachable" })
        if (mode === "replay" && last) return last
        const token =
          mode === "forge" ? mint(body, forger.privateKey) : mode === "wrong-args" ? mint({ ...body, args: Permit.argsHash({ command: "rm -rf /" }) }) : mint(body)
        last = token
        return token
      }),
  }),
)

const guardLayer = Guard.layer.pipe(
  Layer.provide(Layer.mergeAll(Registry.defaultLayer, Grants.defaultLayer, Effective.defaultLayer, fakeGate)),
)
const it = testEffect(Layer.mergeAll(guardLayer, Registry.defaultLayer))

let salt = ""
const saved = { ...process.env }
beforeEach(() => {
  salt = Math.random().toString(36).slice(2, 10)
  mode = "sign"
  last = undefined
  seen = []
  process.env.CROAKCODE_EXECUTION_PERMIT = "required"
  process.env.CROAKCODE_GATE_PERMIT_PUBLIC_KEY = rawPublic
  process.env.CROAKCODE_GATE_PERMIT_URL = "https://gate.test"
})
afterEach(() => {
  for (const key of ["CROAKCODE_EXECUTION_PERMIT", "CROAKCODE_GATE_PERMIT_PUBLIC_KEY", "CROAKCODE_GATE_PERMIT_URL", "CROAK_CONFIG_DIR"]) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})
const session = () => SessionID.make(`ses_${salt}${"0".repeat(17)}1`)

const reason = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return "allowed"
  const err = Cause.squash(exit.cause) as { reason?: string }
  return err.reason ?? String(err)
}

const authorize = (args: unknown = { command: "ls" }, connection: "gate" | "direct" = "gate") =>
  Effect.gen(function* () {
    const guard = yield* Guard.Service
    return yield* guard.authorizeExecution({ sessionID: session(), tool: "bash", args, mode: connection }).pipe(Effect.exit)
  })

const started = Effect.gen(function* () {
  yield* (yield* Guard.Service).beginRun({ sessionID: session(), agent: "build" })
})

describe("execution permit in the guard (Phase 4 Task 9)", () => {
  it.instance("PT-01: a call runs with a permit Gate signed for it", () =>
    Effect.gen(function* () {
      yield* started
      expect(reason(yield* authorize())).toBe("allowed")
      const run = yield* (yield* Registry.Service).activeRun(session())
      expect(seen[0]).toMatchObject({ sid: session(), pid: run!.principalId, rid: run!.id, tool: "bash", args: Permit.argsHash({ command: "ls" }) })
    }),
  )

  it.instance("PT-02: a forged permit is denied and audited", () =>
    Effect.gen(function* () {
      yield* started
      mode = "forge"
      expect(reason(yield* authorize())).toBe("permit_signature")
      expect(Audit.query({ sessionId: session(), eventType: "tool.denied" }).at(-1)?.errorCode).toBe("permit_signature")
    }),
  )

  it.instance("PT-03: a permit for other arguments is denied", () =>
    Effect.gen(function* () {
      yield* started
      mode = "wrong-args"
      expect(reason(yield* authorize())).toBe("permit_mismatch")
    }),
  )

  it.instance("PT-05: a replayed permit is denied", () =>
    Effect.gen(function* () {
      yield* started
      expect(reason(yield* authorize())).toBe("allowed")
      mode = "replay"
      expect(reason(yield* authorize())).toBe("permit_replayed")
    }),
  )

  it.instance("PT-06: on but without a key, a URL, a reachable Gate or a run, every call is denied", () =>
    Effect.gen(function* () {
      yield* started
      delete process.env.CROAKCODE_GATE_PERMIT_PUBLIC_KEY
      expect(reason(yield* authorize())).toBe("permit_no_key")
      process.env.CROAKCODE_GATE_PERMIT_PUBLIC_KEY = rawPublic
      delete process.env.CROAKCODE_GATE_PERMIT_URL
      expect(reason(yield* authorize())).toBe("permit_no_url")
      process.env.CROAKCODE_GATE_PERMIT_URL = "https://gate.test"
      mode = "down"
      expect(reason(yield* authorize())).toBe("permit_unavailable")
    }),
  )

  it.instance("no run means no permit request", () =>
    Effect.gen(function* () {
      expect(reason(yield* authorize())).toBe("no_run")
      expect(seen).toHaveLength(0)
    }),
  )

  it.instance("direct mode and the default setting skip the permit", () =>
    Effect.gen(function* () {
      yield* started
      expect(reason(yield* authorize({ command: "ls" }, "direct"))).toBe("allowed")
      delete process.env.CROAKCODE_EXECUTION_PERMIT
      expect(reason(yield* authorize())).toBe("allowed")
      expect(seen).toHaveLength(0)
    }),
  )
})

describe("permit client against a local fake Gate", () => {
  test("posts the call to /v1/execution-permits with the croak login token", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "croak-cfg-"))
    const far = new Date(Date.now() + 86_400_000).toISOString()
    writeFileSync(
      path.join(dir, "session.json"),
      JSON.stringify({ access_token: "login-token", access_expires_at: far, refresh_token: "r", session_expires_at: far }),
    )
    process.env.CROAK_CONFIG_DIR = dir
    let request: { path: string; auth: string | null; body: unknown } | undefined
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        request = { path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body: await req.json() }
        return Response.json({ token: "a.b" })
      },
    })
    try {
      const body = { sid: "ses_x", pid: "apr_y", rid: "run_z", tool: "bash", args: "h", rev: 0 }
      const token = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* PermitClient.Service).request(`http://127.0.0.1:${server.port}`, body)
        }).pipe(Effect.provide(PermitClient.defaultLayer)),
      )
      expect(token).toBe("a.b")
      expect(request).toEqual({ path: "/v1/execution-permits", auth: "Bearer login-token", body })
    } finally {
      server.stop(true)
    }
  })

  test("fails without a login", async () => {
    process.env.CROAK_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), "croak-cfg-"))
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* (yield* PermitClient.Service).request("http://127.0.0.1:9", {
          sid: "s", pid: "p", rid: "r", tool: "t", args: "a", rev: 0,
        })
      }).pipe(Effect.provide(PermitClient.defaultLayer)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("not logged in")
  })
})
