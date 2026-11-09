import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto"

// Phase 4 Task 9 — execution permit verification (client side).
//
// Gate signs a permit for one tool call with Ed25519; croakcode verifies it
// with Gate's public key right before the tool runs. HMAC is not used: the
// verifier would hold the signing key and could mint permits itself.
//
// Token: base64url(payload JSON) "." base64url(signature). The signature
// covers the ASCII bytes of the first segment, so no JSON canonicalization is
// needed to verify. The payload binds the call:
//   aud "croakcode", sid, pid, rid, tool, args (sha256 of canonical JSON of
//   the tool arguments), rev (Gate's policy revision, recorded only), iat,
//   exp (at most 60 s after iat), nonce (single use).
//
// Guarantee: a normal client does not run a tool without Gate's permit. A
// tampered client can skip this check; stopping it needs Gate to reconcile
// permits with model requests, which is croak-gate's scope.

export const AUDIENCE = "croakcode"
export const MAX_TTL_MS = 60_000
export const CLOCK_SKEW_MS = 30_000

export type Payload = {
  readonly aud: string
  readonly sid: string
  readonly pid: string
  readonly rid: string
  readonly tool: string
  readonly args: string
  readonly rev: number
  readonly iat: number
  readonly exp: number
  readonly nonce: string
}

/** What the current call must match. */
export type Expected = {
  readonly sid: string
  readonly pid: string
  readonly rid: string
  readonly tool: string
  readonly args: string
}

export type Failure =
  | "permit_malformed"
  | "permit_signature"
  | "permit_mismatch"
  | "permit_expired"
  | "permit_not_yet_valid"
  | "permit_ttl"
  | "permit_replayed"

export type Verdict = { readonly ok: true; readonly payload: Payload } | { readonly ok: false; readonly reason: Failure }

/** JSON with object keys sorted at every level; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
}

export function argsHash(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex")
}

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const fromB64url = (text: string) => Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64")

export function encodePayload(payload: Payload): string {
  return b64url(Buffer.from(JSON.stringify(payload)))
}

export function joinToken(payloadSegment: string, signature: Buffer): string {
  return `${payloadSegment}.${b64url(signature)}`
}

/** The SPKI DER prefix of an Ed25519 public key; the raw key is 32 bytes. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

/**
 * Parses Gate's public key: PEM (SPKI), or base64 of the raw 32-byte key.
 * Returns undefined for anything else.
 */
export function parsePublicKey(text: string | undefined): KeyObject | undefined {
  const value = text?.trim()
  if (!value) return undefined
  try {
    if (value.includes("BEGIN PUBLIC KEY")) {
      const key = createPublicKey(value)
      return key.asymmetricKeyType === "ed25519" ? key : undefined
    }
    const raw = Buffer.from(value, "base64")
    if (raw.length !== 32) return undefined
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" })
  } catch {
    return undefined
  }
}

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

/** Remembers used nonces until their permit expires. */
export class NonceStore {
  private readonly used = new Map<string, number>()

  /** Records the nonce; false when it was already used and is still live. */
  claim(nonce: string, exp: number, now: number): boolean {
    for (const [key, until] of this.used) if (until + CLOCK_SKEW_MS < now) this.used.delete(key)
    if (this.used.has(nonce)) return false
    this.used.set(nonce, exp)
    return true
  }
}

export function verify(
  token: string,
  expected: Expected,
  opts: { readonly publicKey: KeyObject; readonly nonces: NonceStore; readonly now?: number },
): Verdict {
  const now = opts.now ?? Date.now()
  const parts = typeof token === "string" ? token.split(".") : []
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "permit_malformed" }
  const [segment, signature] = parts as [string, string]

  let valid = false
  try {
    valid = verifySignature(null, Buffer.from(segment, "ascii"), opts.publicKey, fromB64url(signature))
  } catch {
    valid = false
  }
  if (!valid) return { ok: false, reason: "permit_signature" }

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(fromB64url(segment).toString("utf8"))
  } catch {
    return { ok: false, reason: "permit_malformed" }
  }
  const fields = ["aud", "sid", "pid", "rid", "tool", "args", "nonce"] as const
  if (!fields.every((key) => isString(raw[key])) || !isNumber(raw.iat) || !isNumber(raw.exp) || !isNumber(raw.rev)) {
    return { ok: false, reason: "permit_malformed" }
  }
  const payload = raw as unknown as Payload

  if (
    payload.aud !== AUDIENCE ||
    payload.sid !== expected.sid ||
    payload.pid !== expected.pid ||
    payload.rid !== expected.rid ||
    payload.tool !== expected.tool ||
    payload.args !== expected.args
  ) {
    return { ok: false, reason: "permit_mismatch" }
  }
  if (payload.exp - payload.iat > MAX_TTL_MS || payload.exp < payload.iat) return { ok: false, reason: "permit_ttl" }
  if (payload.iat > now + CLOCK_SKEW_MS) return { ok: false, reason: "permit_not_yet_valid" }
  if (payload.exp + CLOCK_SKEW_MS < now) return { ok: false, reason: "permit_expired" }
  if (!opts.nonces.claim(payload.nonce, payload.exp, now)) return { ok: false, reason: "permit_replayed" }
  return { ok: true, payload }
}

export type Config =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly publicKey?: KeyObject; readonly url?: string }

/**
 * CROAKCODE_EXECUTION_PERMIT=required turns verification on (default off,
 * because croak-gate does not issue permits yet). Gate's key comes from
 * CROAKCODE_GATE_PERMIT_PUBLIC_KEY and the issuing endpoint from
 * CROAKCODE_GATE_PERMIT_URL. Neither has a default: when verification is on
 * and either is missing, every tool is denied.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env.CROAKCODE_EXECUTION_PERMIT?.trim() !== "required") return { enabled: false }
  const publicKey = parsePublicKey(env.CROAKCODE_GATE_PERMIT_PUBLIC_KEY)
  const url = env.CROAKCODE_GATE_PERMIT_URL?.trim().replace(/\/+$/, "") || undefined
  return { enabled: true, ...(publicKey ? { publicKey } : {}), ...(url ? { url } : {}) }
}

export * as Permit from "./permit"
