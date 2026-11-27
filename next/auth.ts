// croak-gate 로그인 세션. 기존 croakcode의 croak-auth 플러그인과 같은
// `~/.config/croak/session.json`(mode 600)을 읽고 쓴다. 토큰은 로그에 남기지 않는다.
//
// - access token: croak-gate 키(24시간)
// - refresh token: 만료 10분 전에 자동 갱신
// - session: 주간 세션 종료 시각(일요일 00:00 KST)
import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** access token 만료 이 시간 전에 미리 갱신한다. */
export const REFRESH_EARLY_MS = 10 * 60 * 1000
const CALL_TIMEOUT_MS = 15_000
const LOCK_TIMEOUT_MS = 30_000

export type ExecutionPermits = {
  required?: boolean
  public_key?: string | null
  url?: string
}

/** session.json에 저장하는 로그인 세션. */
export type AuthSession = {
  access_token: string
  refresh_token?: string
  auth_url?: string
  access_expires_at?: string
  session_expires_at?: string
  user?: Record<string, unknown>
  execution_permits?: ExecutionPermits
}

export class AuthError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function configDir(): string {
  return process.env.CROAK_CONFIG_DIR || join(homedir(), ".config", "croak")
}

export function sessionFile(): string {
  return join(configDir(), "session.json")
}

export function caFile(): string {
  return process.env.CROAK_CA_FILE || join(configDir(), "ca", "ca.crt")
}

/**
 * croak-gate 로그인 서버 주소. 기본값은 두지 않는다(인프라 주소는 소스에 넣지 않는다).
 * `CROAK_AUTH_URL`만 쓴다.
 */
export function authUrl(): string | undefined {
  const value = (process.env.CROAK_AUTH_URL ?? "").trim().replace(/\/+$/, "")
  return value || undefined
}

export function requireAuthUrl(): string {
  const url = authUrl()
  if (!url) throw new AuthError(0, "not_configured", "로그인 서버 주소가 없습니다. CROAK_AUTH_URL 환경 변수를 설정하세요.")
  return url
}

const b64url = (value: Buffer): string =>
  value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/** RFC 7636 verifier와 S256 challenge. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash("sha256").update(verifier).digest())
  return { verifier, challenge }
}

export function loginUrl(challenge: string): string {
  return `${requireAuthUrl()}/auth/login?challenge=${encodeURIComponent(challenge)}`
}

// --- 파일 -------------------------------------------------------------------

export function load(): AuthSession | null {
  try {
    const raw = JSON.parse(readFileSync(sessionFile(), "utf8")) as unknown
    if (!raw || typeof raw !== "object") return null
    const session = raw as Record<string, unknown>
    if (typeof session.access_token !== "string" || session.access_token.length === 0) return null
    if (session.refresh_token !== undefined && typeof session.refresh_token !== "string") return null
    return session as unknown as AuthSession
  } catch {
    return null
  }
}

export function save(session: AuthSession): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 })
  const tmp = `${sessionFile()}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(session, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, sessionFile())
}

export function clear(): void {
  rmSync(sessionFile(), { force: true })
}

/** TUI와 서버가 동시에 갱신하지 않도록 하는 프로세스 간 잠금. */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 })
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
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error
      try {
        if (Date.now() - statSync(dir).mtimeMs > LOCK_TIMEOUT_MS) rmdirSync(dir) // 크래시로 남은 잠금
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error("croak-auth: session lock timed out")
}

// --- 서버 호출 --------------------------------------------------------------

function tlsOptions(): { tls?: { ca: string } } {
  try {
    return { tls: { ca: readFileSync(caFile(), "utf8") } } // Bun: 내부 CA 신뢰
  } catch {
    return {}
  }
}

async function call(method: string, route: string, options: { body?: unknown; token?: string } = {}): Promise<any> {
  const headers: Record<string, string> = { accept: "application/json" }
  if (process.env.CROAKCODE_CLIENT_VERSION) headers["x-croak-client-version"] = process.env.CROAKCODE_CLIENT_VERSION
  if (options.body !== undefined) headers["content-type"] = "application/json"
  if (options.token) headers.authorization = `Bearer ${options.token}`
  const base = requireAuthUrl()
  let response: Response
  try {
    response = await fetch(`${base}${route}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      ...tlsOptions(),
    } as RequestInit)
  } catch (error) {
    throw new AuthError(0, "unreachable", `로그인 서버에 연결하지 못했습니다 (${base}): ${(error as Error)?.message ?? error}`)
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    throw new AuthError(
      response.status,
      typeof data.error === "string" ? data.error : "error",
      typeof data.message === "string" ? data.message : `HTTP ${response.status}`,
    )
  }
  return data
}

function fromTokens(tokens: Record<string, unknown>): AuthSession {
  if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) {
    throw new AuthError(0, "malformed", "로그인 서버 응답에 access_token이 없습니다.")
  }
  const permits = tokens.execution_permits
  return {
    access_token: tokens.access_token,
    access_expires_at: tokens.access_expires_at as string | undefined,
    refresh_token: tokens.refresh_token as string | undefined,
    session_expires_at: tokens.session_expires_at as string | undefined,
    user: tokens.user as Record<string, unknown> | undefined,
    auth_url: authUrl(),
    ...(permits && typeof permits === "object"
      ? {
          execution_permits: {
            required: (permits as Record<string, unknown>).required === true,
            public_key:
              typeof (permits as Record<string, unknown>).public_key === "string"
                ? ((permits as Record<string, unknown>).public_key as string)
                : null,
          },
        }
      : {}),
  }
}

function expired(iso: string | undefined, now: number, early = 0): boolean {
  if (!iso) return true
  const time = Date.parse(iso)
  return !Number.isFinite(time) || time - early <= now
}

/** 브라우저에 보여 준 확인 코드를 토큰으로 바꿔 저장한다. */
export async function exchange(code: string, verifier: string): Promise<AuthSession> {
  const tokens = await call("POST", "/auth/token", {
    body: { grant_type: "authorization_code", code: code.trim(), code_verifier: verifier },
  })
  const session = fromTokens(tokens)
  save(session)
  return session
}

/**
 * 요청에 실을 access token. 만료가 가까우면 갱신한다.
 * 로그인하지 않았거나 주간 세션이 끝났으면 null.
 */
export async function accessToken(now = Date.now()): Promise<string | null> {
  let session = load()
  if (!session) return null
  if (expired(session.session_expires_at, now)) {
    clear()
    return null
  }
  if (!expired(session.access_expires_at, now, REFRESH_EARLY_MS)) return session.access_token
  // refresh token이 없으면 만료 전까지만 쓴다.
  if (!session.refresh_token) return expired(session.access_expires_at, now) ? null : session.access_token

  return withLock(async () => {
    session = load() // 다른 프로세스가 이미 갱신했을 수 있다.
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
        clear() // 서버가 세션을 끝냈다(로그아웃·일요일·잠금·폐기)
        return null
      }
      // 서버에 닿지 않으면 진짜 만료 전까지는 기존 토큰을 쓴다.
      return expired(session.access_expires_at, now) ? null : session.access_token
    }
  })
}

export async function logout(): Promise<boolean> {
  const session = load()
  clear()
  if (!session) return false
  try {
    await call("POST", "/auth/logout", { body: { refresh_token: session.refresh_token } })
  } catch {
    // 로컬 세션은 이미 지웠다. 서버 세션은 일요일에 끝난다.
  }
  return true
}

export async function whoami(): Promise<Record<string, any> | null> {
  const token = await accessToken()
  if (!token) return null
  return call("GET", "/auth/me", { token })
}
