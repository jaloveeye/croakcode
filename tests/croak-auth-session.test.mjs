// node --test plugins/croak-auth/session.test.mjs
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

const dir = mkdtempSync(path.join(tmpdir(), "croak-auth-"))
process.env.CROAK_CONFIG_DIR = dir

// Fake croak-auth: counts calls and answers like the real one.
const calls = []
let refreshStatus = 200
let refreshDelay = 0
const server = createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", async () => {
    const data = body ? JSON.parse(body) : {}
    calls.push({ url: req.url, data, auth: req.headers.authorization })
    const reply = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(obj))
    }
    const tokens = (n) => ({
      access_token: `access-${n}`,
      access_expires_at: new Date(Date.now() + 24 * 3600e3).toISOString(),
      refresh_token: `refresh-${n}`,
      session_expires_at: new Date(Date.now() + 3 * 24 * 3600e3).toISOString(),
      user: { username: "tester", tier: "standard", roles: [] },
    })
    if (req.url === "/auth/token" && data.grant_type === "authorization_code") {
      const ok = data.code === "ABCD-EFGH-JKMN" && data.code_verifier.length >= 43
      return ok ? reply(200, tokens(1)) : reply(400, { error: "invalid_grant", message: "확인 코드가 맞지 않습니다." })
    }
    if (req.url === "/auth/token" && data.grant_type === "refresh_token") {
      if (refreshDelay) await new Promise((r) => setTimeout(r, refreshDelay))
      return refreshStatus === 200 ? reply(200, tokens(calls.length)) : reply(refreshStatus, { error: "session_expired", message: "끝" })
    }
    if (req.url === "/auth/logout") return reply(200, { ok: true })
    if (req.url === "/auth/me") return reply(200, { username: "tester", tier: "standard" })
    reply(404, {})
  })
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
process.env.CROAK_AUTH_URL = `http://127.0.0.1:${server.address().port}`
const S = await import("../upstream/.croakcode/plugins/lib/croak-auth-session.js")

test.after(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

const nearExpiry = () => {
  const s = S.load()
  S.save({ ...s, access_expires_at: new Date(Date.now() + 60e3).toISOString() })
}

test("pkce is RFC 7636 S256", () => {
  const { verifier, challenge } = S.pkce()
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/)
  const expected = createHash("sha256").update(verifier).digest("base64url")
  assert.equal(challenge, expected)
  assert.ok(S.loginUrl(challenge).endsWith(`/auth/login?challenge=${challenge}`))
})

test("a wrong code is rejected and nothing is stored", async () => {
  await assert.rejects(S.exchange("WRONG", S.pkce().verifier), /확인 코드/)
  assert.equal(S.load(), null)
})

test("exchange stores the session with mode 600", async () => {
  const session = await S.exchange(" ABCD-EFGH-JKMN \n", S.pkce().verifier)
  assert.equal(session.access_token, "access-1")
  assert.equal(statSync(S.sessionFile()).mode & 0o777, 0o600)
  assert.equal(await S.accessToken(), "access-1")
})

test("refreshes shortly before expiry, once for concurrent callers", async () => {
  nearExpiry()
  const before = calls.filter((c) => c.data.grant_type === "refresh_token").length
  refreshDelay = 200
  const tokens = await Promise.all([S.accessToken(), S.accessToken(), S.accessToken()])
  refreshDelay = 0
  const after = calls.filter((c) => c.data.grant_type === "refresh_token").length
  assert.equal(after - before, 1)
  assert.equal(new Set(tokens).size, 1)
  assert.notEqual(tokens[0], "access-1")
  assert.equal(S.load().refresh_token, tokens[0].replace("access", "refresh"))
})

test("keeps the token while the server is unreachable", async () => {
  nearExpiry()
  const token = S.load().access_token
  const url = process.env.CROAK_AUTH_URL
  process.env.CROAK_AUTH_URL = "http://127.0.0.1:9"
  assert.equal(await S.accessToken(), token)
  process.env.CROAK_AUTH_URL = url
})

test("a 401 on refresh ends the local session", async () => {
  nearExpiry()
  refreshStatus = 401
  assert.equal(await S.accessToken(), null)
  assert.equal(S.load(), null)
  refreshStatus = 200
})

test("the weekly session end clears the file without a call", async () => {
  await S.exchange("ABCD-EFGH-JKMN", S.pkce().verifier)
  const s = S.load()
  S.save({ ...s, session_expires_at: new Date(Date.now() - 1000).toISOString() })
  const n = calls.length
  assert.equal(await S.accessToken(), null)
  assert.equal(calls.length, n)
  assert.equal(S.load(), null)
})

test("whoami sends the access token", async () => {
  await S.exchange("ABCD-EFGH-JKMN", S.pkce().verifier)
  const me = await S.whoami()
  assert.equal(me.username, "tester")
  assert.equal(calls.at(-1).auth, `Bearer ${S.load().access_token}`)
})

test("logout tells the server and removes the file", async () => {
  const refresh = S.load().refresh_token
  assert.equal(await S.logout(), true)
  assert.deepEqual(calls.at(-1).data, { refresh_token: refresh })
  assert.equal(S.load(), null)
  assert.equal(await S.logout(), false)
})
