#!/usr/bin/env bun
import { randomUUID } from "node:crypto"
import { constants as fsConstants, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { Database } from "bun:sqlite"
import { authorizeRead, openGate, type Gate } from "./gate"
import { completion, type Call, type Message } from "./chat"

const USAGE = `사용법: croakcode-next run <filename> [prompt]

  <filename>  현재 디렉터리의 최상위 짧은 텍스트 파일 하나 (경로 구분자 불가)
  [prompt]    선택 사항. 기본값은 한국어 요약 요청

  --help, -h  이 도움말을 출력한다 (인증 불필요)

Linux 전용 프로토타입이다.`

const DEFAULT_PROMPT = "이 파일의 내용을 한국어로 요약해 주세요."
const UNRUN_RESULT = "[croak] 이 도구 호출은 실행되지 않았다."
const MAX_FILE_BYTES = 16 * 1024
const READ_LIMIT = MAX_FILE_BYTES + 1
const MAX_PROMPT_BYTES = 8 * 1024
const BUSY_TIMEOUT_MS = 5_000

const DENY_DIRS = [".ssh", ".aws", ".gnupg", ".config/croak"]
const DENY_FILES = [".env", "*.env", "*.pem", "*.key", "id_rsa*", "id_ed25519*", "id_ecdsa*"]

class CliError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new CliError(code, message)
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  return new RegExp("^" + escaped.replace(/\*/g, ".*") + "$")
}

const FILE_RES = DENY_FILES.map((glob) => [glob, globToRegex(glob)] as const)

function deniedPath(value: string): string | null {
  const segs = value.trim().replace(/\\/g, "/").split("/").filter(Boolean)
  for (const dir of DENY_DIRS) {
    const parts = dir.split("/")
    for (let i = 0; i + parts.length <= segs.length; i++) {
      if (parts.every((p, j) => segs[i + j] === p)) return dir
    }
  }
  const base = segs.at(-1) ?? ""
  for (const [glob, re] of FILE_RES) if (re.test(base)) return glob
  return null
}

function validateFilename(raw: string): string {
  if (!raw) fail("filename_invalid", "파일 이름이 비어 있다")
  if (raw.includes("/") || raw.includes("\\")) fail("filename_invalid", "경로 구분자는 허용되지 않는다")
  if (raw === "." || raw === "..") fail("filename_invalid", "상대 경로 표기는 허용되지 않는다")
  if (raw.includes("\0")) fail("filename_invalid", "NUL 문자는 허용되지 않는다")
  if (basename(raw) !== raw) fail("filename_invalid", "최상위 파일 이름만 허용된다")
  const denied = deniedPath(raw)
  if (denied) fail("filename_denied", `비밀 파일 이름은 허용되지 않는다 (${denied})`)
  const cwdDenied = deniedPath(join(process.cwd(), raw))
  if (cwdDenied) fail("filename_denied", `비밀 경로 세그먼트는 허용되지 않는다 (${cwdDenied})`)
  return raw
}

function validatePrompt(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_PROMPT
  const trimmed = raw.trim()
  if (!trimmed) return DEFAULT_PROMPT
  if (Buffer.byteLength(trimmed, "utf8") > MAX_PROMPT_BYTES) fail("prompt_too_large", "프롬프트가 너무 크다")
  return trimmed
}

function dataDir(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(base, "croakcode-next")
}

function openDb(): Database {
  const dir = dataDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const db = new Database(join(dir, "sessions.db"), { create: true })
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL, error TEXT)")
  db.exec(
    "CREATE TABLE IF NOT EXISTS messages (session_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (session_id, seq))",
  )
  db.exec("CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, exp INTEGER NOT NULL)")
  return db
}

type Store = {
  sessionId: string
  persist(body: Message): void
  setStatus(status: "running" | "completed" | "error", error?: string | null): void
  claim(nonce: string, exp: number): boolean
  close(): void
}

function createStore(): Store {
  const db = openDb()
  const sessionId = `ses_${randomUUID()}`
  db.query("INSERT INTO sessions (id, status, error) VALUES (?, 'running', NULL)").run(sessionId)
  let seq = 0
  const insert = db.query("INSERT INTO messages (session_id, seq, body) VALUES (?, ?, ?)")
  const status = db.query("UPDATE sessions SET status = ?, error = ? WHERE id = ?")
  const nonce = db.query("INSERT OR IGNORE INTO nonces (nonce, exp) VALUES (?, ?)")
  const prune = db.query("DELETE FROM nonces WHERE exp < ?")
  return {
    sessionId,
    persist(body: Message) {
      insert.run(sessionId, seq, JSON.stringify(body))
      seq += 1
    },
    setStatus(next, error = null) {
      status.run(next, error, sessionId)
    },
    claim(value: string, exp: number) {
      prune.run(Date.now() - 30_000)
      const result = nonce.run(value, exp)
      return result.changes === 1
    },
    close() {
      try {
        db.close()
      } catch {
        // 닫기 실패는 무시한다
      }
    },
  }
}

function trimPatterns(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== "string") return null
    const trimmed = item.trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
}

function checkPolicy(sid: string): void {
  if (process.env.CROAKCODE_ADMIN_POLICY_FILE) {
    fail("policy_unsupported", "CROAKCODE_ADMIN_POLICY_FILE는 이 프로토타입에서 지원되지 않는다")
  }
  const file =
    process.env.CROAK_TOOL_POLICY_FILE ||
    join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "croak", "tool-policy.json")
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    fail("policy_unavailable", "정책 파일을 읽을 수 없다")
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    fail("policy_unavailable", "정책 파일이 올바른 JSON이 아니다")
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("policy_unavailable", "정책 파일 형식이 올바르지 않다")
  const policy = raw as Record<string, unknown>
  const deny = trimPatterns(policy.deny)
  if (deny === null) fail("policy_unavailable", "정책 deny 목록 형식이 올바르지 않다")
  const sessions =
    policy.sessions && typeof policy.sessions === "object" && !Array.isArray(policy.sessions)
      ? (policy.sessions as Record<string, unknown>)
      : {}
  const patterns = [...deny]
  for (const key of ["*", sid]) {
    if (!(key in sessions)) continue
    const sessionDeny = trimPatterns(sessions[key])
    if (sessionDeny === null) fail("policy_unavailable", "정책 세션 deny 목록 형식이 올바르지 않다")
    patterns.push(...sessionDeny)
  }
  const denied = patterns.some((pattern) => {
    if (pattern === "*") return true
    if (pattern.endsWith("*")) return "read".startsWith(pattern.slice(0, -1))
    return pattern === "read"
  })
  if (denied) fail("policy_denied", "로컬 정책이 read 도구를 금지한다")
}

function validateCall(calls: Call[], filename: string): Call {
  if (calls.length !== 1) fail("call_invalid", "도구 호출은 정확히 하나여야 한다")
  const call = calls[0] as Call
  if (call.type !== "function" || call.function.name !== "read") fail("call_invalid", "read 도구 호출만 허용된다")
  let args: unknown
  try {
    args = JSON.parse(call.function.arguments)
  } catch {
    fail("call_invalid", "도구 인자가 JSON이 아니다")
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) fail("call_invalid", "도구 인자는 객체여야 한다")
  const keys = Object.keys(args as Record<string, unknown>)
  if (keys.length !== 1 || keys[0] !== "filePath") fail("call_invalid", "filePath 외 인자는 허용되지 않는다")
  const filePath = (args as Record<string, unknown>).filePath
  if (typeof filePath !== "string" || filePath !== filename) fail("call_invalid", "filePath가 CLI 파일 이름과 다르다")
  return call
}

function readFileBounded(filename: string): string {
  let fd: number
  try {
    fd = openSync(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
  } catch {
    fail("read_failed", "파일을 열 수 없다")
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) fail("read_failed", "일반 파일이 아니다")
    if (stat.size > MAX_FILE_BYTES) fail("read_failed", "파일이 너무 크다")
    const buffer = Buffer.alloc(READ_LIMIT)
    let total = 0
    while (total < READ_LIMIT) {
      const n = readSync(fd, buffer, total, READ_LIMIT - total, total)
      if (n <= 0) break
      total += n
    }
    if (total > MAX_FILE_BYTES) fail("read_failed", "파일이 너무 크다")
    const bytes = buffer.subarray(0, total)
    if (bytes.includes(0)) fail("read_failed", "NUL 문자가 포함되어 있다")
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      fail("read_failed", "UTF-8로 해석할 수 없다")
    }
  } finally {
    try {
      closeSync(fd)
    } catch {
      // 닫기 실패는 무시한다
    }
  }
}

function firstUserMessage(filename: string, prompt: string): string {
  return [
    `파일 이름: ${filename}`,
    `요청: ${prompt}`,
    `반드시 read 도구를 호출하고 filePath 인자에 정확히 "${filename}"을 넣어라.`,
    "다른 도구나 다른 인자는 허용되지 않는다.",
  ].join("\n")
}

function safeErrorReason(error: unknown): string {
  if (error instanceof CliError) return `${error.code}: ${error.message}`
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === "string") {
    if (code === "gate_unavailable" || code === "gate_denied" || code === "login_required") {
      return `${code}: 인증 또는 게이트 오류`
    }
    if (code === "stream_error" || code === "stream_failed") return `${code}: 스트림 오류`
  }
  const message = (error as { message?: unknown } | null)?.message
  if (typeof message === "string") {
    const permit = /^(permit_[a-z_]+)$/.exec(message.trim())
    if (permit) return permit[1] as string
  }
  return "run_failed: 실행 중 오류가 발생했다"
}

async function run(filename: string, prompt: string): Promise<void> {
  if (process.platform !== "linux") fail("platform_unsupported", "현재 Linux만 지원한다")

  const store = createStore()
  try {
    const gate = openGate()
    const sid = store.sessionId
    const rid = `run_${randomUUID()}`
    const pid = `apr_${randomUUID()}`

    const system: Message = {
      role: "system",
      content: "너는 파일 읽기 도구를 사용하는 도우미다. 지시된 도구 호출만 수행한다.",
    }
    const user: Message = { role: "user", content: firstUserMessage(filename, prompt) }
    store.persist(system)
    store.persist(user)

    const first = await completion(gate, { sid, rid }, [system, user], true)

    const assistant: Message = {
      role: "assistant",
      content: first.text.length > 0 ? first.text : null,
      tool_calls: first.calls,
    }

    const failRun = (error: unknown, callID: string): never => {
      const reason = safeErrorReason(error)
      const toolMessage: Message = { role: "tool", content: UNRUN_RESULT, tool_call_id: callID }
      store.persist(toolMessage)
      store.setStatus("error", reason)
      fail("run_failed", reason)
    }

    store.persist(assistant)

    let call: Call
    let toolContent: string
    try {
      call = validateCall(first.calls, filename)
      checkPolicy(sid)
      await authorizeRead(gate, { sid, rid, pid }, { filePath: filename }, store.claim)
      toolContent = readFileBounded(filename)
    } catch (error) {
      failRun(error, first.calls[0]?.id ?? "")
    }

    const toolMessage: Message = { role: "tool", content: toolContent, tool_call_id: call.id }
    store.persist(toolMessage)

    const second = await completion(gate, { sid, rid }, [system, user, assistant, toolMessage], false)
    const finalMessage: Message = { role: "assistant", content: second.text }
    store.persist(finalMessage)
    store.setStatus("completed")
    process.stdout.write(second.text.endsWith("\n") ? second.text : second.text + "\n")
  } catch (error) {
    const reason = safeErrorReason(error)
    try {
      store.setStatus("error", reason)
    } catch {
      // 상태 기록 실패는 무시한다
    }
    if (error instanceof CliError) throw error
    throw new CliError("run_failed", reason)
  } finally {
    store.close()
  }
}

function main(argv: string[]): void {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE + "\n")
    return
  }
  const [command, ...rest] = argv
  if (command !== "run") fail("usage", "알 수 없는 명령이다. --help를 참고하라")
  if (rest.length === 0) fail("usage", "파일 이름이 필요하다")
  if (rest.length > 2) fail("usage", "인자가 너무 많다")
  const filename = validateFilename(rest[0] as string)
  const prompt = validatePrompt(rest[1])
  run(filename, prompt).catch((error: unknown) => {
    const reason = safeErrorReason(error)
    process.stderr.write(`croakcode-next: ${reason}\n`)
    process.exitCode = 1
  })
}

if (import.meta.main) {
  process.umask(0o077)
  try {
    main(process.argv.slice(2))
  } catch (error) {
    const reason = safeErrorReason(error)
    process.stderr.write(`croakcode-next: ${reason}\n`)
    process.exitCode = 1
  }
}
