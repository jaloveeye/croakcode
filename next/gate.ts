import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { accessToken, configDir, load as loadAuthSession, type AuthSession } from "./auth"

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

type Session = AuthSession & {
  access_token: string
  auth_url: string
  access_expires_at?: string
  session_expires_at: string
  execution_permits?: { required?: unknown; public_key?: unknown; url?: unknown }
}

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

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
  const s = loadAuthSession() as Record<string, unknown> | null
  if (!s) throw loginNeeded("session.json not found or malformed")
  if (!isString(s.auth_url)) throw loginNeeded("auth_url missing")
  if (!isString(s.session_expires_at)) throw loginNeeded("session_expires_at missing")
  const sessionExp = Date.parse(s.session_expires_at)
  if (!Number.isFinite(sessionExp)) throw loginNeeded("session_expires_at is not a valid date")
  if (sessionExp <= Date.now()) throw loginNeeded("session expired")
  // access token은 refresh token이 있으면 요청 시점에 자동 갱신한다.
  const accessExp = typeof s.access_expires_at === "string" ? Date.parse(s.access_expires_at) : Number.NaN
  if (!(Number.isFinite(accessExp) && accessExp > Date.now()) && !isString(s.refresh_token)) {
    throw loginNeeded("access token expired")
  }
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
    // 요청마다 토큰을 읽어 만료가 가까우면 갱신한다(장시간 세션 대응).
    let token: string | null
    try {
      token = await accessToken()
    } catch (error) {
      throw loginNeeded((error as Error)?.message ?? "access token unavailable")
    }
    if (!token) throw loginNeeded("session expired")
    const init: RequestInit & { tls?: { ca?: string } } = {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
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

export type PermitTool = "read" | "write" | "edit" | "glob" | "grep" | "shell" | "apply_patch"

const STRING_ARGS: Record<PermitTool, readonly string[]> = {
  read: ["filePath"],
  write: ["filePath", "content"],
  edit: ["filePath", "oldString", "newString"],
  glob: ["pattern"],
  grep: ["pattern", "include"],
  shell: ["command"],
  apply_patch: ["patchText"],
}

function permitArgsError(): never {
  throw new Error("permit_malformed")
}

/** 도구별 인자 모양을 엄격히 검사한다(추가 필드·누락·타입 불일치 거부). */
function validatePermitArgs(tool: PermitTool, args: Record<string, unknown>): void {
  if (!args || typeof args !== "object" || Array.isArray(args)) permitArgsError()
  const allowed = new Set<string>([
    ...STRING_ARGS[tool],
    ...(tool === "edit" ? ["replaceAll"] : []),
    ...(tool === "shell" ? ["args"] : []),
  ])
  for (const key of Object.keys(args)) if (!allowed.has(key)) permitArgsError()
  for (const key of STRING_ARGS[tool]) {
    if (typeof args[key] !== "string") permitArgsError()
  }
  if (tool === "read" && (args.filePath as string).length === 0) permitArgsError()
  if (tool === "write") {
    if ((args.filePath as string).length === 0) permitArgsError()
  }
  if (tool === "edit") {
    if ((args.filePath as string).length === 0 || (args.oldString as string).length === 0) permitArgsError()
    if (typeof args.replaceAll !== "boolean") permitArgsError()
  }
  if ((tool === "glob" || tool === "grep") && (args.pattern as string).length === 0) permitArgsError()
  if (tool === "shell") {
    if ((args.command as string).length === 0) permitArgsError()
    if (!Array.isArray(args.args) || !(args.args as unknown[]).every((arg) => typeof arg === "string")) {
      permitArgsError()
    }
  }
  if (tool === "apply_patch" && (args.patchText as string).trim().length === 0) permitArgsError()
}

/**
 * 도구 실행 허가를 게이트에 요청하고 서명된 permit을 검증한다.
 * args 는 도구별로 정해진 키만 포함해야 하며, 그대로 해시되어 서명 대상이 된다.
 */
export async function authorizeTool(
  gate: Gate,
  ids: { sid: string; rid: string; pid: string },
  tool: PermitTool,
  args: Record<string, unknown>,
  claim: (nonce: string, exp: number) => boolean,
): Promise<void> {
  validatePermitArgs(tool, args)

  const argsHash = sha256Hex(JSON.stringify(args))
  const body = {
    sid: ids.sid,
    rid: ids.rid,
    pid: ids.pid,
    tool,
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

  verifyPermit(token, { sid: ids.sid, pid: ids.pid, rid: ids.rid, tool, args: argsHash }, gate.publicKey, claim)
}

export async function authorizeRead(
  gate: Gate,
  ids: { sid: string; rid: string; pid: string },
  args: { filePath: string },
  claim: (nonce: string, exp: number) => boolean,
): Promise<void> {
  await authorizeTool(gate, ids, "read", args, claim)
}
