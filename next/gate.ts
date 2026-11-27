import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CLIENT_VERSION = "0.1.0"
const AGENT = "dev-safe"
const AUDIENCE = "croakcode"
const MAX_TTL_MS = 60_000
const CLOCK_SKEW_MS = 30_000
const PERMIT_TIMEOUT_MS = 10_000
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

const ENV_ALLOWLIST = [
  "CROAK_AUTH_URL",
  "LITELLM_BASE_URL",
  "NODE_EXTRA_CA_CERTS",
  "CROAK_CA_FILE",
  "CROAKCODE_GATE_PERMIT_URL",
  "CROAKCODE_GATE_PERMIT_PUBLIC_KEY",
] as const

type Identity = { sid: string; rid: string }

export type Gate = {
  post(route: string, body: unknown, identity: Identity, timeoutMs: number): Promise<Response>
  publicKey: KeyObject
}

type Session = {
  access_token: string
  auth_url: string
  access_expires_at: string
  session_expires_at: string
  execution_permits?: { required?: unknown; public_key?: unknown; url?: unknown }
}

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

function configDir(): string {
  return process.env.CROAK_CONFIG_DIR || join(homedir(), ".config", "croak")
}

function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(path)) return out
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return out
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

function loadConfig(): Record<string, string> {
  const file = readEnvFile(join(configDir(), "croakcode.env"))
  const merged: Record<string, string> = {}
  for (const key of ENV_ALLOWLIST) {
    const fromEnv = process.env[key]
    if (isString(fromEnv)) merged[key] = fromEnv
    else if (isString(file[key])) merged[key] = file[key]
  }
  return merged
}

function loginNeeded(reason: string): Error {
  return new Error(`croak login required: ${reason}`)
}

function parseOrigin(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw loginNeeded("auth_url is not a valid URL")
  }
  if (url.username || url.password) throw loginNeeded("auth_url must not contain credentials")
  if (url.search) throw loginNeeded("auth_url must not contain a query")
  if (url.hash) throw loginNeeded("auth_url must not contain a fragment")
  if (url.pathname !== "/" && url.pathname !== "") throw loginNeeded("auth_url must not contain a path")
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw loginNeeded("auth_url must use HTTPS (HTTP only for loopback)")
  }
  return url
}

function loadSession(): Session {
  const path = join(configDir(), "session.json")
  if (!existsSync(path)) throw loginNeeded("session.json not found")
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    throw loginNeeded("session.json is not valid JSON")
  }
  if (!raw || typeof raw !== "object") throw loginNeeded("session.json is malformed")
  const s = raw as Record<string, unknown>
  if (!isString(s.access_token)) throw loginNeeded("access_token missing")
  if (!isString(s.auth_url)) throw loginNeeded("auth_url missing")
  if (!isString(s.access_expires_at)) throw loginNeeded("access_expires_at missing")
  if (!isString(s.session_expires_at)) throw loginNeeded("session_expires_at missing")
  const now = Date.now()
  const accessExp = Date.parse(s.access_expires_at)
  const sessionExp = Date.parse(s.session_expires_at)
  if (!Number.isFinite(accessExp)) throw loginNeeded("access_expires_at is not a valid date")
  if (!Number.isFinite(sessionExp)) throw loginNeeded("session_expires_at is not a valid date")
  if (accessExp <= now) throw loginNeeded("access token expired")
  if (sessionExp <= now) throw loginNeeded("session expired")
  return s as unknown as Session
}

function parsePublicKey(text: string | undefined): KeyObject | undefined {
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

function loadPublicKey(config: Record<string, string>, session: Session): KeyObject {
  const explicit = config.CROAKCODE_GATE_PERMIT_PUBLIC_KEY
  const fromSession = session.execution_permits?.public_key
  const text = isString(explicit) ? explicit : isString(fromSession) ? fromSession : undefined
  if (!text) throw new Error("permit_unavailable: no trusted login key configured")
  const key = parsePublicKey(text)
  if (!key) throw new Error("permit_unavailable: trusted login key is invalid")
  return key
}

function resolveCa(config: Record<string, string>): string | undefined {
  const explicit = config.CROAK_CA_FILE || config.NODE_EXTRA_CA_CERTS
  if (isString(explicit)) {
    if (!existsSync(explicit)) throw new Error("permit_unavailable: configured CA file not found")
    try {
      return readFileSync(explicit, "utf8")
    } catch {
      throw new Error("permit_unavailable: configured CA file is unreadable")
    }
  }
  const fallback = join(configDir(), "ca", "ca.crt")
  if (existsSync(fallback)) {
    try {
      return readFileSync(fallback, "utf8")
    } catch {
      throw new Error("permit_unavailable: configured CA file is unreadable")
    }
  }
  return undefined
}

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
}

const ALLOWED_ROUTES = ["/v1/chat/completions", "/v1/execution-permits"] as const

function routeUrl(origin: URL, route: string): string {
  if (!(ALLOWED_ROUTES as readonly string[]).includes(route)) {
    throw new Error("permit_unavailable: unsupported route")
  }
  return new URL(route, origin).toString()
}

export function openGate(): Gate {
  const config = loadConfig()
  const session = loadSession()
  const configuredRaw = config.CROAK_AUTH_URL
  if (!isString(configuredRaw)) throw new Error("permit_unavailable: CROAK_AUTH_URL is not configured")
  const configured = parseOrigin(configuredRaw)
  const origin = parseOrigin(session.auth_url)
  if (!sameOrigin(configured, origin)) throw new Error("permit_unavailable: auth URL conflicts with session")

  const permitUrlRaw = config.CROAKCODE_GATE_PERMIT_URL
  if (isString(permitUrlRaw)) {
    let permitUrl: URL
    try {
      permitUrl = new URL(permitUrlRaw)
    } catch {
      throw new Error("permit_unavailable: permit URL is invalid")
    }
    if (!sameOrigin(permitUrl, origin)) throw new Error("permit_unavailable: permit URL conflicts with auth origin")
  }

  const providerRaw = config.LITELLM_BASE_URL
  if (isString(providerRaw)) {
    let providerUrl: URL
    try {
      providerUrl = new URL(providerRaw)
    } catch {
      throw new Error("permit_unavailable: provider URL is invalid")
    }
    if (!sameOrigin(providerUrl, origin)) throw new Error("permit_unavailable: provider URL conflicts with auth origin")
  }

  const publicKey = loadPublicKey(config, session)
  const ca = resolveCa(config)

  const post = async (route: string, body: unknown, identity: Identity, timeoutMs: number): Promise<Response> => {
    const url = routeUrl(origin, route)
    const init: RequestInit & { tls?: { ca?: string } } = {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.access_token}`,
        "content-type": "application/json",
        "x-croak-session": identity.sid,
        "x-croak-agent": AGENT,
        "x-croak-run": identity.rid,
        "x-croak-client-version": CLIENT_VERSION,
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    }
    if (ca) init.tls = { ca }
    return await fetch(url, init as RequestInit)
  }

  return { post, publicKey }
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64")
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

type PermitPayload = {
  aud: string
  sid: string
  pid: string
  rid: string
  tool: string
  args: string
  nonce: string
  iat: number
  exp: number
  rev: number
}

function verifyPermit(
  token: string,
  expected: { sid: string; pid: string; rid: string; tool: string; args: string },
  publicKey: KeyObject,
  claim: (nonce: string, exp: number) => boolean,
): PermitPayload {
  const now = Date.now()
  const parts = typeof token === "string" ? token.split(".") : []
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("permit_malformed")
  const [segment, signature] = parts as [string, string]

  let valid = false
  try {
    valid = verifySignature(null, Buffer.from(segment, "ascii"), publicKey, fromB64url(signature))
  } catch {
    valid = false
  }
  if (!valid) throw new Error("permit_signature")

  let parsed: unknown
  try {
    parsed = JSON.parse(fromB64url(segment).toString("utf8"))
  } catch {
    throw new Error("permit_malformed")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("permit_malformed")
  const raw = parsed as Record<string, unknown>
  const fields = ["aud", "sid", "pid", "rid", "tool", "args", "nonce"] as const
  if (!fields.every((key) => isString(raw[key])) || !isNumber(raw.iat) || !isNumber(raw.exp) || !isNumber(raw.rev)) {
    throw new Error("permit_malformed")
  }
  const payload = raw as unknown as PermitPayload

  if (
    payload.aud !== AUDIENCE ||
    payload.sid !== expected.sid ||
    payload.pid !== expected.pid ||
    payload.rid !== expected.rid ||
    payload.tool !== expected.tool ||
    payload.args !== expected.args
  ) {
    throw new Error("permit_mismatch")
  }
  if (payload.exp - payload.iat > MAX_TTL_MS || payload.exp < payload.iat) throw new Error("permit_ttl")
  if (payload.iat > now + CLOCK_SKEW_MS) throw new Error("permit_not_yet_valid")
  if (payload.exp + CLOCK_SKEW_MS < now) throw new Error("permit_expired")

  let fresh = false
  try {
    fresh = claim(payload.nonce, payload.exp)
  } catch {
    throw new Error("permit_nonce_unavailable")
  }
  if (!fresh) throw new Error("permit_replayed")
  return payload
}

export async function authorizeRead(
  gate: Gate,
  ids: { sid: string; rid: string; pid: string },
  args: { filePath: string },
  claim: (nonce: string, exp: number) => boolean,
): Promise<void> {
  if (!args || typeof args !== "object" || !isString(args.filePath)) throw new Error("permit_malformed")
  const keys = Object.keys(args)
  if (keys.length !== 1 || keys[0] !== "filePath") throw new Error("permit_malformed")

  const argsHash = sha256Hex(JSON.stringify(args))
  const body = {
    sid: ids.sid,
    rid: ids.rid,
    pid: ids.pid,
    tool: "read",
    args: argsHash,
    rev: 0,
  }

  let response: Response
  try {
    response = await gate.post("/v1/execution-permits", body, { sid: ids.sid, rid: ids.rid }, PERMIT_TIMEOUT_MS)
  } catch {
    throw new Error("permit_unavailable")
  }
  if (!response.ok) throw new Error("permit_unavailable")

  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new Error("permit_malformed")
  }
  if (!data || typeof data !== "object") throw new Error("permit_malformed")
  const token = (data as Record<string, unknown>).token
  if (!isString(token)) throw new Error("permit_malformed")

  verifyPermit(token, { sid: ids.sid, pid: ids.pid, rid: ids.rid, tool: "read", args: argsHash }, gate.publicKey, claim)
}
