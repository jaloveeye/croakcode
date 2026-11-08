// Login session shared by the croak-auth TUI plugin (/login, /logout,
// /whoami) and server plugin (adds the access token to every model request).
//
// The session lives in ~/.config/croak/session.json (mode 600):
// access token (a croak-gate key, 24 hours), refresh token, and the time the
// weekly session ends (Sunday 00:00 KST). Tokens are never logged.
import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const env = (name, fallback) => process.env[name] || fallback

export const configDir = () => env("CROAK_CONFIG_DIR", path.join(homedir(), ".config", "croak"))
export const sessionFile = () => path.join(configDir(), "session.json")
export const caFile = () => env("CROAK_CA_FILE", path.join(configDir(), "ca", "ca.crt"))
export const authUrl = () => env("CROAK_AUTH_URL", "https://172.16.0.201:8443").replace(/\/+$/, "")

/** Refresh this long before the access token expires. */
export const REFRESH_EARLY_MS = 10 * 60 * 1000

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/** RFC 7636 verifier and S256 challenge. */
export function pkce() {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash("sha256").update(verifier).digest())
  return { verifier, challenge }
}

export const loginUrl = (challenge) => `${authUrl()}/auth/login?challenge=${encodeURIComponent(challenge)}`

// --- file ------------------------------------------------------------------

export function load() {
  try {
    const s = JSON.parse(readFileSync(sessionFile(), "utf8"))
    return s && typeof s.access_token === "string" && typeof s.refresh_token === "string" ? s : null
  } catch {
    return null
  }
}

export function save(session) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 })
  const tmp = `${sessionFile()}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(session, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, sessionFile())
}

export function clear() {
  rmSync(sessionFile(), { force: true })
}

/** A tiny cross-process lock so the TUI and server do not refresh at once. */
async function withLock(fn) {
  const dir = `${sessionFile()}.lock`
  for (let i = 0; i < 100; i++) {
    try {
      mkdirSync(dir)
      try {
        return await fn()
      } finally {
        rmdirSync(dir)
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      try {
        if (Date.now() - statSync(dir).mtimeMs > 30_000) rmdirSync(dir) // left by a crash
      } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error("croak-auth: session lock timed out")
}

// --- server calls ----------------------------------------------------------

export class AuthError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function tlsOptions() {
  try {
    return { tls: { ca: readFileSync(caFile(), "utf8") } } // Bun: trust the internal CA
  } catch {
    return {}
  }
}

async function call(method, route, { body, token } = {}) {
  const headers = { accept: "application/json" }
  if (body !== undefined) headers["content-type"] = "application/json"
  if (token) headers.authorization = `Bearer ${token}`
  let res
  try {
    res = await fetch(`${authUrl()}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
      ...tlsOptions(),
    })
  } catch (error) {
    throw new AuthError(0, "unreachable", `로그인 서버에 연결하지 못했습니다 (${authUrl()}): ${error?.message ?? error}`)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new AuthError(res.status, data.error ?? "error", data.message ?? `HTTP ${res.status}`)
  return data
}

const fromTokens = (t) => ({
  access_token: t.access_token,
  access_expires_at: t.access_expires_at,
  refresh_token: t.refresh_token,
  session_expires_at: t.session_expires_at,
  user: t.user,
  auth_url: authUrl(),
})

/** Exchanges the code shown in the browser for tokens and stores them. */
export async function exchange(code, verifier) {
  const tokens = await call("POST", "/auth/token", {
    body: { grant_type: "authorization_code", code: code.trim(), code_verifier: verifier },
  })
  const session = fromTokens(tokens)
  save(session)
  return session
}

const expired = (iso, now, early = 0) => !iso || Date.parse(iso) - early <= now

/**
 * The access token to send, refreshing it when it is about to expire.
 * Returns null when not logged in or when the weekly session has ended.
 */
export async function accessToken(now = Date.now()) {
  let session = load()
  if (!session) return null
  if (expired(session.session_expires_at, now)) {
    clear()
    return null
  }
  if (!expired(session.access_expires_at, now, REFRESH_EARLY_MS)) return session.access_token
  return withLock(async () => {
    session = load() // another process may have refreshed meanwhile
    if (!session) return null
    if (!expired(session.access_expires_at, now, REFRESH_EARLY_MS)) return session.access_token
    try {
      const tokens = await call("POST", "/auth/token", {
        body: { grant_type: "refresh_token", refresh_token: session.refresh_token },
      })
      const next = fromTokens(tokens)
      save(next)
      return next.access_token
    } catch (error) {
      if (error instanceof AuthError && error.status === 401) {
        clear() // session ended on the server: logout, Sunday, lock or revoke
        return null
      }
      // Server unreachable: keep using the token until it really expires.
      return expired(session.access_expires_at, now) ? null : session.access_token
    }
  })
}

export async function logout() {
  const session = load()
  clear()
  if (!session) return false
  try {
    await call("POST", "/auth/logout", { body: { refresh_token: session.refresh_token } })
  } catch {
    // The local session is gone either way; the server ends it on Sunday.
  }
  return true
}

export async function whoami() {
  const token = await accessToken()
  if (!token) return null
  return call("GET", "/auth/me", { token })
}
