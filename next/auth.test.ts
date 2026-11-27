import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash, generateKeyPairSync } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import * as auth from "./auth"
import { openGate } from "./gate"
import { readPolicy } from "./policy"
import { startSession, type Session } from "./session"

let root = ""
let server: ReturnType<typeof Bun.serve> | null = null
let baseUrl = ""
let handle: (request: Request, body: any, url: URL) => Response | Promise<Response>
const calls: { path: string; body: any; authorization: string | null }[] = []

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })

const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString()
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function start(next: typeof handle): void {
  handle = next
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url)
      const body = request.method === "POST" ? await request.json().catch(() => ({})) : {}
      calls.push({ path: url.pathname, body, authorization: request.headers.get("authorization") })
      return handle(request, body, url)
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
  process.env.CROAK_AUTH_URL = baseUrl
}

function writeSession(values: Partial<auth.AuthSession> & { access_token: string }): void {
  auth.save({
    auth_url: baseUrl,
    access_expires_at: iso(HOUR),
    session_expires_at: iso(7 * DAY),
    refresh_token: "refresh-1",
    ...values,
  })
}

function tokens(access: string, refresh: string): Response {
  return json({
    access_token: access,
    refresh_token: refresh,
    access_expires_at: iso(HOUR),
    session_expires_at: iso(7 * DAY),
    user: { username: "herace", tier: "full" },
    execution_permits: { required: true, public_key: null },
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "croak-auth-"))
  calls.length = 0
  process.env.CROAK_CONFIG_DIR = join(root, "config")
  process.env.CROAK_NO_BROWSER = "1"
  process.env.XDG_DATA_HOME = join(root, "data")
  process.env.XDG_RUNTIME_DIR = join(root, "run")
  process.env.CROAK_TOOL_POLICY_FILE = join(root, "tool-policy.json")
  delete process.env.CROAKCODE_ADMIN_POLICY_FILE
})

afterEach(() => {
  server?.stop(true)
  server = null
  delete process.env.CROAK_CONFIG_DIR
  delete process.env.CROAK_AUTH_URL
  delete process.env.CROAK_NO_BROWSER
  delete process.env.XDG_DATA_HOME
  delete process.env.XDG_RUNTIME_DIR
  delete process.env.CROAK_TOOL_POLICY_FILE
  rmSync(root, { recursive: true, force: true })
})

describe("auth session", () => {
  test("pkce and login URL carry an S256 challenge", () => {
    start(() => json({}))
    const { verifier, challenge } = auth.pkce()
    const expected = createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    expect(challenge).toBe(expected)
    expect(auth.loginUrl(challenge)).toBe(`${baseUrl}/auth/login?challenge=${encodeURIComponent(challenge)}`)
  })

  test("exchange stores tokens and auth_url", async () => {
    start((request, body, url) => {
      expect(url.pathname).toBe("/auth/token")
      expect(body).toEqual({ grant_type: "authorization_code", code: "CODE-1", code_verifier: "verifier-1" })
      return tokens("access-1", "refresh-1")
    })
    const session = await auth.exchange(" CODE-1 ", "verifier-1")
    expect(session.access_token).toBe("access-1")
    expect(session.auth_url).toBe(baseUrl)
    expect(auth.load()?.refresh_token).toBe("refresh-1")
    const raw = JSON.parse(readFileSync(auth.sessionFile(), "utf8")) as Record<string, unknown>
    expect(raw.access_token).toBe("access-1")
  })

  test("valid access token is returned without a server call", async () => {
    start(() => {
      throw new Error("should not call the server")
    })
    writeSession({ access_token: "access-1" })
    expect(await auth.accessToken()).toBe("access-1")
    expect(calls).toHaveLength(0)
  })

  test("token near expiry is refreshed and the new refresh token is saved", async () => {
    start((request, body, url) => {
      expect(url.pathname).toBe("/auth/token")
      expect(body).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-1" })
      return tokens("access-2", "refresh-2")
    })
    writeSession({ access_token: "access-1", access_expires_at: iso(5 * 60 * 1000) })
    expect(await auth.accessToken()).toBe("access-2")
    expect(auth.load()?.refresh_token).toBe("refresh-2")
    expect(calls).toHaveLength(1)
  })

  test("expired weekly session is cleared", async () => {
    start(() => json({}))
    writeSession({ access_token: "access-1", session_expires_at: iso(-1000) })
    expect(await auth.accessToken()).toBeNull()
    expect(auth.load()).toBeNull()
  })

  test("401 on refresh clears the session", async () => {
    start(() => json({ error: "invalid_grant", message: "revoked" }, 401))
    writeSession({ access_token: "access-1", access_expires_at: iso(-1000) })
    expect(await auth.accessToken()).toBeNull()
    expect(auth.load()).toBeNull()
  })

  test("unreachable refresh keeps a still-valid access token, then gives up at expiry", async () => {
    start(() => json({}))
    process.env.CROAK_AUTH_URL = "http://127.0.0.1:1"
    writeSession({ access_token: "access-1", access_expires_at: iso(5 * 60 * 1000) })
    expect(await auth.accessToken()).toBe("access-1")
    writeSession({ access_token: "access-1", access_expires_at: iso(-1000) })
    expect(await auth.accessToken()).toBeNull()
  })

  test("logout clears locally and tells the server", async () => {
    start((request, body, url) => {
      expect(url.pathname).toBe("/auth/logout")
      expect(body).toEqual({ refresh_token: "refresh-1" })
      return json({})
    })
    writeSession({ access_token: "access-1" })
    expect(await auth.logout()).toBe(true)
    expect(auth.load()).toBeNull()
    expect(calls).toHaveLength(1)
  })

  test("whoami sends the access token", async () => {
    start((request, body, url) => {
      expect(url.pathname).toBe("/auth/me")
      return json({ username: "herace", tier: "full" })
    })
    writeSession({ access_token: "access-1" })
    const me = await auth.whoami()
    expect(me?.username).toBe("herace")
    expect(calls[0]?.authorization).toBe("Bearer access-1")
  })
})

describe("gate token refresh", () => {
  test("permit request uses the refreshed token", async () => {
    start((request, body, url) => {
      if (url.pathname === "/auth/token") return tokens("fresh-token", "refresh-2")
      if (url.pathname === "/v1/execution-permits") return json({ token: "permit" })
      return json({ error: "not_found" }, 404)
    })
    const { publicKey } = generateKeyPairSync("ed25519")
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12)
    writeSession({
      access_token: "stale-token",
      access_expires_at: iso(-1000),
      execution_permits: { required: true, public_key: raw.toString("base64") },
    })
    const gate = openGate()
    const response = await gate.post("/v1/execution-permits", { sid: "s1" }, { sid: "s1", rid: "r1" }, 5000)
    expect(response.ok).toBe(true)
    const permit = calls.find((call) => call.path === "/v1/execution-permits")
    expect(permit?.authorization).toBe("Bearer fresh-token")
  })
})

function output(sink: string[]) {
  return {
    write(chunk: string | Uint8Array): boolean {
      sink.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    },
  } as unknown as NodeJS.WritableStream
}

describe("session auth commands", () => {
  test("/login, /whoami, /agent-perm, /logout", async () => {
    start((request, body, url) => {
      if (url.pathname === "/auth/token") return tokens("access-1", "refresh-1")
      if (url.pathname === "/auth/me") {
        return json({
          username: "herace",
          tier: "full",
          roles: ["admin"],
          rules: { agents: ["build"], deny_tools: ["webfetch"] },
          session_expires_at: iso(7 * DAY),
        })
      }
      if (url.pathname === "/auth/logout") return json({})
      return json({ error: "not_found" }, 404)
    })
    const sink: string[] = []
    const input = new PassThrough()
    const session: Session = await startSession({
      name: "auth-test",
      cwd: root,
      input: input as unknown as NodeJS.ReadableStream,
      output: output(sink),
    })
    try {
      await session.handleLine("/login")
      expect(sink.join("\n")).toContain("/auth/login?challenge=")
      expect(sink.join("\n")).toContain("`/login <코드>`")

      await session.handleLine("/login CODE-1")
      expect(sink.join("\n")).toContain("herace님, 로그인했다.")
      expect(auth.load()?.access_token).toBe("access-1")

      await session.handleLine("/whoami")
      const who = sink.join("\n")
      expect(who).toContain("herace · full 등급")
      expect(who).toContain("관리 권한: admin")
      expect(who).toContain("금지 도구: webfetch")

      await session.handleLine("/agent-perm")
      expect(sink.join("\n")).toContain("read: 켜짐")
      await session.handleLine("/agent-perm read")
      expect(sink.join("\n")).toContain("read: 껐다")
      expect(readPolicy().sessions[session.id]).toEqual(["read"])
      await session.handleLine("/agent-perm read")
      expect(sink.join("\n")).toContain("read: 켰다")
      expect(readPolicy().sessions[session.id]).toBeUndefined()

      await session.handleLine("/logout")
      expect(sink.join("\n")).toContain("로그아웃했다")
      expect(auth.load()).toBeNull()
    } finally {
      await session.interrupt()
    }
  })

  test("/agent-perm refuses tools denied by the global policy", async () => {
    start(() => json({}))
    writeFileSync(process.env.CROAK_TOOL_POLICY_FILE as string, JSON.stringify({ deny: ["read"] }))
    const sink: string[] = []
    const input = new PassThrough()
    const session = await startSession({
      name: "policy-test",
      cwd: root,
      input: input as unknown as NodeJS.ReadableStream,
      output: output(sink),
    })
    try {
      await session.handleLine("/agent-perm read")
      expect(sink.join("\n")).toContain("전역/등급 정책이 금지한다")
      expect(readPolicy().sessions[session.id]).toBeUndefined()
    } finally {
      await session.interrupt()
    }
  })
})
