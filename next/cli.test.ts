import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { createHistoryStore } from "./store"
import type { Message } from "./chat"

const ENTRY = join(import.meta.dir, "cli.ts")
const README_MARKER = "CROAK_TEST_README_MARKER_7f3a"
const OTHER_MARKER = "CROAK_TEST_OTHER_MARKER_91bc"
const KOREAN_REPLY = "요약: 테스트용 README 파일입니다."
const SECRET_FILENAME = "." + "env"

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

let root = ""
let binPath = ""
let server: ReturnType<typeof Bun.serve> | null = null
let baseUrl = ""
let privateKeyPem = ""
let publicKeyRaw = ""

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function b64url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function signPermit(payload: Record<string, unknown>): string {
  const segment = b64url(Buffer.from(JSON.stringify(payload), "utf8"))
  const signature = sign(null, Buffer.from(segment, "ascii"), privateKeyPem)
  return `${segment}.${b64url(signature)}`
}

function sse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n"
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

function toolCallEvents(id: string, name: string, argsObject: Record<string, unknown>): unknown[] {
  const args = JSON.stringify(argsObject)
  const split = Math.floor(args.length / 2)
  return [
    { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, split) } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(split) } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]
}

function textEvents(text: string): unknown[] {
  return [
    { choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]
}

type Mode =
  | "success"
  | "permit503"
  | "wrongArgs"
  | "write"
  | "writeEnv"
  | "writePermit503"
  | "edit"
  | "glob"
  | "grep"
  | "shell"
  | "shellDenied"

let lastPermit = { tool: "", argsHash: "", calls: 0 }

function startServer(mode: Mode): void {
  lastPermit = { tool: "", argsHash: "", calls: 0 }
  const state = { toolCallId: "", toolArgsHash: "", sawTool: false, permitCalls: 0 }
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/v1/chat/completions") {
        const body = (await req.json()) as { messages: Array<Record<string, unknown>> }
        const messages = body.messages
        const hasTool = messages.some((m) => m.role === "tool")
        const scenario =
          mode === "write" || mode === "writePermit503"
            ? "write"
            : mode === "writeEnv"
              ? "writeEnv"
              : mode === "edit"
                ? "edit"
                : mode === "glob"
                  ? "glob"
                  : mode === "grep"
                    ? "grep"
                    : mode === "shell"
                      ? "shell"
                      : mode === "shellDenied"
                        ? "shellDenied"
                        : "read"
        if (!hasTool) {
          const id = `call_${randomUUID()}`
          state.toolCallId = id
          if (scenario === "write") return sse(toolCallEvents(id, "write", { filePath: "OUT.md", content: "written by tool\n" }))
          if (scenario === "writeEnv") return sse(toolCallEvents(id, "write", { filePath: SECRET_FILENAME, content: "SECRET=1\n" }))
          if (scenario === "edit") {
            return sse(toolCallEvents(id, "edit", { filePath: "EDIT.md", oldString: "beta", newString: "BETA", replaceAll: false }))
          }
          if (scenario === "glob") return sse(toolCallEvents(id, "glob", { pattern: "**/*.md" }))
          if (scenario === "grep") {
            return sse(toolCallEvents(id, "grep", { pattern: "CROAK_TEST", include: "README*.md" }))
          }
          if (scenario === "shell") {
            return sse(toolCallEvents(id, "shell", { command: "bun", args: ["--version"] }))
          }
          if (scenario === "shellDenied") {
            return sse(toolCallEvents(id, "shell", { command: "rm", args: ["-rf", "/"] }))
          }
          return sse(toolCallEvents(id, "read", { filePath: "README.md" }))
        }
        const tool = messages.find((m) => m.role === "tool") as Record<string, unknown>
        const assistant = messages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls)) as Record<string, unknown>
        const calls = assistant.tool_calls as Array<Record<string, unknown>>
        const callId = calls[0]?.id
        if (tool.tool_call_id !== callId || callId !== state.toolCallId) {
          return new Response("bad tool id", { status: 400 })
        }
        const content = typeof tool.content === "string" ? tool.content : ""
        let ok: boolean
        if (scenario === "glob") {
          ok = content.includes("README.md") && content.includes("OTHER.md")
        } else if (scenario === "grep") {
          ok = content.includes("README.md") && !content.includes("OTHER.md") && content.includes("CROAK_TEST")
        } else if (scenario === "shell") {
          ok = content.startsWith("exit=0") && /\d+\.\d+\.\d+/.test(content)
        } else if (scenario === "shellDenied") {
          ok = content.includes("허용되지 않은 명령")
        } else {
          const expected =
            scenario === "write" ? "파일을 썼다" : scenario === "writeEnv" ? "오류" : scenario === "edit" ? "곳을 바꿨다" : README_MARKER
          ok = content.includes(expected)
        }
        if (!ok && !content.startsWith("오류:")) return new Response("bad tool content", { status: 400 })
        state.sawTool = true
        return sse(textEvents(KOREAN_REPLY))
      }
      if (url.pathname === "/v1/execution-permits") {
        state.permitCalls += 1
        lastPermit.calls += 1
        const body = (await req.json()) as Record<string, unknown>
        if (mode === "permit503" || mode === "writePermit503") return new Response("unavailable", { status: 503 })
        const sid = String(body.sid)
        const rid = String(body.rid)
        const pid = String(body.pid)
        const tool = String(body.tool)
        const argsHash = String(body.args)
        state.toolArgsHash = argsHash
        lastPermit.tool = tool
        lastPermit.argsHash = argsHash
        const now = Date.now()
        const signedArgs = mode === "wrongArgs" ? sha256Hex(JSON.stringify({ filePath: "OTHER.md" })) : argsHash
        const token = signPermit({
          aud: "croakcode",
          sid,
          pid,
          rid,
          tool,
          args: signedArgs,
          nonce: `nonce_${randomUUID()}`,
          iat: now,
          exp: now + 30_000,
          rev: 0,
        })
        return Response.json({ token })
      }
      return new Response("not found", { status: 404 })
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
}

function stopServer(): void {
  if (server) {
    server.stop(true)
    server = null
  }
}

function makeWorkspace(): string {
  const dir = mkdtempSync(join(root, "ws-"))
  writeFileSync(join(dir, "README.md"), `# 테스트\n\n${README_MARKER}\n`)
  writeFileSync(join(dir, "OTHER.md"), `# 다른 파일\n\n${OTHER_MARKER}\n`)
  return dir
}

function makeEnv(workspace: string, deny: string[] = []): Record<string, string> {
  const configDir = join(workspace, ".config")
  const dataHome = join(workspace, ".data")
  const policyFile = join(workspace, "tool-policy.json")
  mkdirSync(configDir, { recursive: true })
  mkdirSync(dataHome, { recursive: true })
  writeFileSync(policyFile, JSON.stringify({ deny }))
  const session = {
    access_token: "test-token",
    auth_url: baseUrl,
    access_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    session_expires_at: new Date(Date.now() + 7_200_000).toISOString(),
    execution_permits: { required: true, public_key: publicKeyRaw, url: `${baseUrl}/v1/execution-permits` },
  }
  writeFileSync(join(configDir, "session.json"), JSON.stringify(session))
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: workspace,
    TMPDIR: workspace,
    CROAK_AUTH_URL: baseUrl,
    LITELLM_BASE_URL: baseUrl,
    CROAK_CONFIG_DIR: configDir,
    CROAK_TOOL_POLICY_FILE: policyFile,
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: join(workspace, ".xdg-config"),
    XDG_CACHE_HOME: join(workspace, ".xdg-cache"),
  }
}

async function runCli(
  workspace: string,
  args: string[],
  options: { input?: string; deny?: string[] } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([binPath, ...args], {
    cwd: workspace,
    env: makeEnv(workspace, options.deny),
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (options.input !== undefined) {
    proc.stdin?.write(options.input)
    proc.stdin?.end()
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

function openSessions(workspace: string): Database {
  return new Database(join(workspace, ".data", "croakcode-next", "sessions.db"))
}

/** 이력 DB 에 대화형 세션 하나를 심는다(자식 CLI 와 같은 XDG_DATA_HOME 사용). */
function seedHistory(workspace: string): string {
  const prevData = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = join(workspace, ".data")
  try {
    const store = createHistoryStore(workspace)
    store.persist({ role: "user", content: "안녕" } as Message)
    store.persist({ role: "assistant", content: "반가워" } as Message)
    store.setStatus("closed")
    store.close()
    return store.id
  } finally {
    if (prevData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevData
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "croak-next-test-"))
  binPath = join(root, "croakcode-next")
  const build = Bun.spawn(["bun", "build", "--compile", ENTRY, "--outfile", binPath], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const code = await build.exited
  if (code !== 0) {
    const err = await new Response(build.stderr).text()
    throw new Error(`compile failed: ${err}`)
  }
  chmodSync(binPath, 0o755)

  const pair = generateKeyPairSync("ed25519")
  privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const raw = pair.publicKey.export({ type: "spki", format: "der" })
  publicKeyRaw = Buffer.from(raw).subarray(ED25519_SPKI_PREFIX.length).toString("base64")
})

afterAll(() => {
  stopServer()
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true })
})

describe("croakcode-next cli", () => {
  test("help works without login", async () => {
    const workspace = makeWorkspace()
    const result = await runCli(workspace, ["--help"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("사용법")
  })

  test("successful read persists tool message and exits 0", async () => {
    startServer("success")
    try {
      const workspace = makeWorkspace()
      const result = await runCli(workspace, ["run", "README.md"])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(KOREAN_REPLY)

      const db = openSessions(workspace)
      try {
        const session = db.query("SELECT id, status, error FROM sessions").get() as { id: string; status: string; error: string | null }
        expect(session.status).toBe("completed")
        expect(session.error).toBeNull()
        const rows = db.query("SELECT seq, body FROM messages WHERE session_id = ? ORDER BY seq").all(session.id) as Array<{ seq: number; body: string }>
        const tool = rows.map((r) => JSON.parse(r.body) as Record<string, unknown>).find((m) => m.role === "tool")
        expect(tool).toBeDefined()
        expect(tool?.content).toContain(README_MARKER)
        expect(tool?.content).not.toContain(OTHER_MARKER)
        const expectedDigest = sha256Hex(JSON.stringify({ filePath: "README.md" }))
        expect(expectedDigest).toHaveLength(64)
      } finally {
        db.close()
      }
    } finally {
      stopServer()
    }
  })

  test("permit 503 fails without executing read", async () => {
    startServer("permit503")
    try {
      const workspace = makeWorkspace()
      const result = await runCli(workspace, ["run", "README.md"])
      expect(result.code).not.toBe(0)
      const db = openSessions(workspace)
      try {
        const session = db.query("SELECT id, status, error FROM sessions").get() as { id: string; status: string; error: string | null }
        expect(session.status).toBe("error")
        expect(session.error ?? "").toContain("permit_unavailable")
        const rows = db.query("SELECT body FROM messages WHERE session_id = ? ORDER BY seq").all(session.id) as Array<{ body: string }>
        const tool = rows.map((r) => JSON.parse(r.body) as Record<string, unknown>).find((m) => m.role === "tool")
        expect(tool).toBeDefined()
        expect(String(tool?.content)).not.toContain(README_MARKER)
      } finally {
        db.close()
      }
    } finally {
      stopServer()
    }
  })

  test("wrong signed args fail and do not read file", async () => {
    startServer("wrongArgs")
    try {
      const workspace = makeWorkspace()
      const result = await runCli(workspace, ["run", "README.md"])
      expect(result.code).not.toBe(0)
      const db = openSessions(workspace)
      try {
        const session = db.query("SELECT id, status, error FROM sessions").get() as { id: string; status: string; error: string | null }
        expect(session.status).toBe("error")
        const rows = db.query("SELECT body FROM messages WHERE session_id = ? ORDER BY seq").all(session.id) as Array<{ body: string }>
        const tool = rows.map((r) => JSON.parse(r.body) as Record<string, unknown>).find((m) => m.role === "tool")
        expect(tool).toBeDefined()
        expect(String(tool?.content)).not.toContain(README_MARKER)
      } finally {
        db.close()
      }
    } finally {
      stopServer()
    }
  })



  test("glob 도구는 permit 후 파일 목록을 돌려준다", async () => {
    startServer("glob")
    try {
      const workspace = makeWorkspace()
      const result = await runCli(workspace, ["session", "--no-tui"], { input: "마크다운 찾아줘\n" })
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(KOREAN_REPLY)
      expect(lastPermit.tool).toBe("glob")
      expect(lastPermit.argsHash).toBe(sha256Hex(JSON.stringify({ pattern: "**/*.md" })))
    } finally {
      stopServer()
    }
  })

  test("grep 도구는 include 로 대상을 좁힌다", async () => {
    startServer("grep")
    try {
      const workspace = makeWorkspace()
      const result = await runCli(workspace, ["session", "--no-tui"], { input: "마커 찾아줘\n" })
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(KOREAN_REPLY)
      expect(lastPermit.tool).toBe("grep")
      expect(lastPermit.argsHash).toBe(
        sha256Hex(JSON.stringify({ pattern: "CROAK_TEST", include: "README*.md" })),
      )
    } finally {
      stopServer()
    }
  })

  test("shell 도구는 허용목록 명령을 permit 후 실행한다", async () => {
    startServer("shell")
    try {
      const workspace = makeWorkspace()
      const result = await runCli(workspace, ["session", "--no-tui"], { input: "버전 확인해줘\n" })
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(KOREAN_REPLY)
      expect(lastPermit.tool).toBe("shell")
      expect(lastPermit.argsHash).toBe(sha256Hex(JSON.stringify({ command: "bun", args: ["--version"] })))
    } finally {
      stopServer()
    }
  })

  test("shell 도구는 허용목록 밖 명령을 permit 없이 거부한다", async () => {
    startServer("shellDenied")
    try {
      const workspace = makeWorkspace()
      const result = await runCli(workspace, ["session", "--no-tui"], { input: "지워줘\n" })
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(KOREAN_REPLY)
      expect(lastPermit.calls).toBe(0)
    } finally {
      stopServer()
    }
  })

  test("resume --list 는 저장된 세션이 없으면 안내한다", async () => {
    const workspace = makeWorkspace()
    const result = await runCli(workspace, ["resume", "--list"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("저장된 세션이 없다")
  })

  test("resume --list 는 저장된 대화형 세션을 보여준다", async () => {
    const workspace = makeWorkspace()
    const id = seedHistory(workspace)
    const result = await runCli(workspace, ["resume", "--list"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(id)
    expect(result.stdout).toContain("closed")
    expect(result.stdout).toContain("2개")
  })

  test("저장된 세션이 없으면 resume --last 는 실패한다", async () => {
    const workspace = makeWorkspace()
    const result = await runCli(workspace, ["resume", "--last"])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("저장된 세션이 없다")
  })


  test("write 도구는 permit 검증 후 파일을 쓴다", async () => {
    startServer("write")
    try {
      const workspace = makeWorkspace()
      const result = await runCli(workspace, ["session", "--no-tui"], { input: "OUT.md 만들어줘\n" })
      expect(result.code).toBe(0)
      expect(readFileSync(join(workspace, "OUT.md"), "utf8")).toBe("written by tool\n")
      expect(lastPermit.tool).toBe("write")
      expect(lastPermit.argsHash).toBe(
        sha256Hex(JSON.stringify({ filePath: "OUT.md", content: "written by tool\n" })),
      )
    } finally {
      stopServer()
    }
  })

  test("write permit 실패 시 파일을 만들지 않는다", async () => {
    startServer("writePermit503")
    try {
      const workspace = makeWorkspace()
      const result = await runCli(workspace, ["session", "--no-tui"], { input: "OUT.md 만들어줘\n" })
      expect(result.code).toBe(0)
      expect(existsSync(join(workspace, "OUT.md"))).toBe(false)
      expect(lastPermit.calls).toBe(1)
    } finally {
      stopServer()
    }
  })

  test("비밀 경로 write 는 permit 전에 거부한다", async () => {
    startServer("writeEnv")
    try {
      const workspace = makeWorkspace()
      const result = await runCli(workspace, ["session", "--no-tui"], { input: "비밀 파일 써줘\n" })
      expect(result.code).toBe(0)
      expect(existsSync(join(workspace, SECRET_FILENAME))).toBe(false)
      expect(lastPermit.calls).toBe(0)
    } finally {
      stopServer()
    }
  })

  test("로컬 정책이 write 를 금지하면 permit 을 요청하지 않는다", async () => {
    startServer("write")
    try {
      const workspace = makeWorkspace()
      const result = await runCli(workspace, ["session", "--no-tui"], { input: "OUT.md 만들어줘\n", deny: ["write"] })
      expect(result.code).toBe(0)
      expect(existsSync(join(workspace, "OUT.md"))).toBe(false)
      expect(lastPermit.calls).toBe(0)
    } finally {
      stopServer()
    }
  })

  test("edit 도구는 permit 검증 후 문자열을 바꾼다", async () => {
    startServer("edit")
    try {
      const workspace = makeWorkspace()
      writeFileSync(join(workspace, "EDIT.md"), "alpha beta alpha\n")
      const result = await runCli(workspace, ["session", "--no-tui"], { input: "beta 를 고쳐줘\n" })
      expect(result.code).toBe(0)
      expect(readFileSync(join(workspace, "EDIT.md"), "utf8")).toBe("alpha BETA alpha\n")
      expect(lastPermit.tool).toBe("edit")
      expect(lastPermit.argsHash).toBe(
        sha256Hex(
          JSON.stringify({ filePath: "EDIT.md", oldString: "beta", newString: "BETA", replaceAll: false }),
        ),
      )
    } finally {
      stopServer()
    }
  })

  test("mismatched filename cannot read other file", async () => {
    startServer("success")
    try {
      const workspace = makeWorkspace()
      const result = await runCli(workspace, ["run", "OTHER.md"])
      expect(result.code).not.toBe(0)
      const db = openSessions(workspace)
      try {
        const session = db.query("SELECT id, status, error FROM sessions").get() as { id: string; status: string; error: string | null }
        expect(session.status).toBe("error")
        const rows = db.query("SELECT body FROM messages WHERE session_id = ? ORDER BY seq").all(session.id) as Array<{ body: string }>
        const tool = rows.map((r) => JSON.parse(r.body) as Record<string, unknown>).find((m) => m.role === "tool")
        expect(tool).toBeDefined()
        expect(String(tool?.content)).not.toContain(OTHER_MARKER)
      } finally {
        db.close()
      }
    } finally {
      stopServer()
    }
  })
})
