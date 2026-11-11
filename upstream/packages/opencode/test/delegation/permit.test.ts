import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { Permit } from "../../src/delegation/permit"

const gate = generateKeyPairSync("ed25519")
const other = generateKeyPairSync("ed25519")
const rawPublic = (key = gate.publicKey) => key.export({ format: "der", type: "spki" }).subarray(-32).toString("base64")

const NOW = 1_800_000_000_000
const expected = { sid: "ses_a", pid: "apr_b", rid: "run_c", tool: "bash", args: Permit.argsHash({ command: "ls" }) }

function mint(overrides: Partial<Permit.Payload> = {}, key = gate.privateKey) {
  const payload: Permit.Payload = {
    aud: "croakcode",
    ...expected,
    rev: 3,
    iat: NOW,
    exp: NOW + 30_000,
    nonce: Math.random().toString(36).slice(2),
    ...overrides,
  }
  const segment = Permit.encodePayload(payload)
  return Permit.joinToken(segment, sign(null, Buffer.from(segment, "ascii"), key))
}

const check = (token: string, opts: { now?: number; nonces?: Permit.Nonces } = {}) =>
  Permit.verify(token, expected, { publicKey: gate.publicKey, nonces: opts.nonces ?? new Permit.NonceStore(), now: opts.now ?? NOW })

describe("canonical arguments", () => {
  test("key order does not change the hash; values do", () => {
    expect(Permit.canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: "x" } })).toBe('{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}')
    expect(Permit.argsHash({ a: 1, b: 2 })).toBe(Permit.argsHash({ b: 2, a: 1 }))
    expect(Permit.argsHash({ a: 1 })).not.toBe(Permit.argsHash({ a: 2 }))
    expect(Permit.argsHash({ a: 1, b: undefined })).toBe(Permit.argsHash({ a: 1 }))
  })
})

describe("execution permit verification (Phase 4 Task 9)", () => {
  test("PT-01: a permit Gate signed for this exact call verifies", () => {
    const verdict = check(mint())
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.payload.rev).toBe(3)
  })

  test("PT-02: a permit signed with another key, or altered, is denied", () => {
    expect(check(mint({}, other.privateKey))).toEqual({ ok: false, reason: "permit_signature" })
    const [segment, signature] = mint().split(".")
    const altered = Permit.encodePayload({ ...JSON.parse(Buffer.from(segment!, "base64url").toString()), tool: "read" })
    expect(check(`${altered}.${signature}`)).toEqual({ ok: false, reason: "permit_signature" })
    expect(check("not-a-token")).toEqual({ ok: false, reason: "permit_malformed" })
  })

  test("PT-03: a permit for another session, principal, run, tool or arguments is denied", () => {
    for (const field of ["sid", "pid", "rid", "tool"] as const) {
      expect(check(mint({ [field]: "other" }))).toEqual({ ok: false, reason: "permit_mismatch" })
    }
    expect(check(mint({ args: Permit.argsHash({ command: "rm -rf /" }) }))).toEqual({ ok: false, reason: "permit_mismatch" })
    expect(check(mint({ aud: "someone-else" }))).toEqual({ ok: false, reason: "permit_mismatch" })
  })

  test("PT-04: expiry with 30 s clock skew, and a lifetime of at most 60 s", () => {
    expect(check(mint(), { now: NOW + 30_000 + 29_000 }).ok).toBe(true)
    expect(check(mint(), { now: NOW + 30_000 + 31_000 })).toEqual({ ok: false, reason: "permit_expired" })
    expect(check(mint({ iat: NOW + 40_000, exp: NOW + 50_000 }))).toEqual({ ok: false, reason: "permit_not_yet_valid" })
    expect(check(mint({ exp: NOW + 61_000 }))).toEqual({ ok: false, reason: "permit_ttl" })
  })

  test("PT-05: a nonce works once", () => {
    const nonces = new Permit.NonceStore()
    const token = mint()
    expect(check(token, { nonces }).ok).toBe(true)
    expect(check(token, { nonces })).toEqual({ ok: false, reason: "permit_replayed" })
  })

  test("PT-05: a nonce record that cannot be used denies", () => {
    const broken: Permit.Nonces = {
      claim() {
        throw new Error("database is locked")
      },
    }
    expect(check(mint(), { nonces: broken })).toEqual({ ok: false, reason: "permit_nonce_unavailable" })
  })

  test("PT-06: verification is off by default; on without a key or URL is reported", () => {
    expect(Permit.loadConfig({}, null)).toEqual({ enabled: false })
    expect(Permit.loadConfig({ CROAKCODE_EXECUTION_PERMIT: "off" }, null)).toEqual({ enabled: false })
    expect(Permit.loadConfig({ CROAKCODE_EXECUTION_PERMIT: "required" }, null)).toEqual({ enabled: true })
    const on = Permit.loadConfig(
      {
        CROAKCODE_EXECUTION_PERMIT: "required",
        CROAKCODE_GATE_PERMIT_PUBLIC_KEY: rawPublic(),
        CROAKCODE_GATE_PERMIT_URL: "https://gate.example/",
      },
      null,
    )
    expect(on.enabled && on.publicKey !== undefined && on.url).toBe("https://gate.example")
  })

  test("by default the login decides: the gate's answer turns verification on", () => {
    const login = { required: true, public_key: rawPublic(), url: "https://gate.example/" }
    const on = Permit.loadConfig({}, login)
    expect(on.enabled && on.publicKey !== undefined && on.url).toBe("https://gate.example")
    expect(Permit.loadConfig({}, { ...login, required: false })).toEqual({ enabled: false })
    expect(Permit.loadConfig({}, undefined)).toEqual({ enabled: false })
    // A tier that requires permits with no key from the gate denies every tool (PT-06).
    expect(Permit.loadConfig({}, { required: true, public_key: null, url: "https://gate.example" })).toEqual({
      enabled: true,
      url: "https://gate.example",
    })
    // The environment overrides the login, both ways.
    expect(Permit.loadConfig({ CROAKCODE_EXECUTION_PERMIT: "off" }, login)).toEqual({ enabled: false })
    expect(Permit.loadConfig({ CROAKCODE_EXECUTION_PERMIT: "required" }, { required: false })).toEqual({ enabled: true })
  })

  test("public keys are accepted as PEM or raw base64 Ed25519 only", () => {
    const pem = gate.publicKey.export({ format: "pem", type: "spki" }).toString()
    expect(Permit.parsePublicKey(pem)?.asymmetricKeyType).toBe("ed25519")
    expect(Permit.parsePublicKey(rawPublic())?.asymmetricKeyType).toBe("ed25519")
    expect(Permit.parsePublicKey("short")).toBeUndefined()
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "pem", type: "spki" }).toString()
    expect(Permit.parsePublicKey(rsa)).toBeUndefined()
  })
})
