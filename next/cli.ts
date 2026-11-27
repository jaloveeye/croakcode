#!/usr/bin/env bun
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { authorizeRead, openGate, type Gate } from "./gate"
import { completion, type Call, type Message } from "./chat"
import { readFileBounded, SafeError, validateFilename } from "./fsafe"
import {
  createHistoryStore,
  createStore,
  forkHistory,
  importLegacyHistory,
  latestHistory,
  listHistory,
  loadHistory,
} from "./store"
import { startSession, SessionError } from "./session"
import { createTui } from "./tui"
import { listPeers, PeerError } from "./peers"

const USAGE = `사용법: croakcode-next <command> [args]

  run <filename> [prompt]   파일을 읽어 요약한다 (경로 구분자 불가)
  session [--name <이름>]    대화형 세션을 연다(다른 세션과 메시지 교환)
    --tui / --no-tui         전체화면 TUI 강제/해제 (기본: TTY면 TUI)
  resume                    저장된 세션을 이어간다(기본: --last)
    --last                   가장 최근 세션
    --session <id>           지정한 세션
    --list                   저장된 세션 목록(run 이력·기존 croakcode DB 포함)
    --fork                   새 세션으로 복제해 이어간다(원본 보존)
    --name <이름>            세션 이름 (기본: resume-<pid>)
  sessions                  실행 중인 세션 목록을 보여준다

  --help, -h  이 도움말을 출력한다 (인증 불필요)

세션 안에서는 /help 로 명령 목록을 볼 수 있다.

Linux 전용 프로토타입이다.`

const DEFAULT_PROMPT = "이 파일의 내용을 한국어로 요약해 주세요."
const UNRUN_RESULT = "[croak] 이 도구 호출은 실행되지 않았다."
const MAX_PROMPT_BYTES = 8 * 1024

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

function validatePrompt(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_PROMPT
  const trimmed = raw.trim()
  if (!trimmed) return DEFAULT_PROMPT
  if (Buffer.byteLength(trimmed, "utf8") > MAX_PROMPT_BYTES) fail("prompt_too_large", "프롬프트가 너무 크다")
  return trimmed
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

function readFileBoundedForRun(filename: string): string {
  try {
    return readFileBounded(filename)
  } catch (error) {
    if (error instanceof SafeError) fail(error.code, error.message)
    throw error
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
  if (error instanceof SessionError || error instanceof PeerError) return `${error.code}: ${error.message}`
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
      toolContent = readFileBoundedForRun(filename)
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

async function commandSession(argv: string[]): Promise<void> {
  if (process.platform !== "linux") fail("platform_unsupported", "현재 Linux만 지원한다")
  let name = `session-${process.pid}`
  let forceTui = false
  let forceNoTui = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--name") {
      name = argv[i + 1] ?? ""
      if (!name) fail("usage", "--name 뒤에 이름이 필요하다")
      i++
    } else if (arg === "--tui") {
      forceTui = true
    } else if (arg === "--no-tui") {
      forceNoTui = true
    } else {
      fail("usage", "알 수 없는 인자다. --help를 참고하라")
    }
  }

  await launchSession({ name, forceTui, forceNoTui })
}

type LaunchOptions = {
  name: string
  cwd?: string
  history?: Message[]
  onAppend?: (message: Message) => void
  forceTui: boolean
  forceNoTui: boolean
}

async function launchSession(options: LaunchOptions): Promise<void> {
  const useTui = options.forceTui || (!options.forceNoTui && Boolean(process.stdin.isTTY && process.stdout.isTTY))
  const common = {
    name: options.name,
    cwd: options.cwd,
    history: options.history,
    onAppend: options.onAppend,
    input: process.stdin,
    output: process.stdout,
  }
  if (!useTui) {
    const session = await startSession(common)
    const shutdown = () => {
      session.interrupt().finally(() => process.exit(0))
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
    // 입력이 끝나거나 /quit 이 처리될 때까지 기다린다.
    await session.stop()
    return
  }

  const tui = createTui(process.stdin, process.stdout, { name: options.name, inbound: "hold", activity: "idle", peers: 1 })
  // 상태줄의 피어 수는 주기적으로 레지스트리에서 다시 센다.
  tui.setStatusProvider(() => ({ peers: Math.max(1, listPeers().length) }))
  const session = await startSession({ ...common, tui })
  tui.start(session)
  const shutdown = () => {
    tui.close()
    session.interrupt().finally(() => process.exit(0))
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  await session.stop()
  tui.close()
}

async function commandResume(argv: string[]): Promise<void> {
  if (process.platform !== "linux") fail("platform_unsupported", "현재 Linux만 지원한다")
  let byLast = false
  let list = false
  let fork = false
  let sessionId: string | null = null
  let name: string | null = null
  let forceTui = false
  let forceNoTui = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--last") {
      byLast = true
    } else if (arg === "--list") {
      list = true
    } else if (arg === "--fork") {
      fork = true
    } else if (arg === "--session") {
      sessionId = argv[i + 1] ?? ""
      if (!sessionId) fail("usage", "--session 뒤에 세션 id가 필요하다")
      i++
    } else if (arg === "--name") {
      name = argv[i + 1] ?? ""
      if (!name) fail("usage", "--name 뒤에 이름이 필요하다")
      i++
    } else if (arg === "--tui") {
      forceTui = true
    } else if (arg === "--no-tui") {
      forceNoTui = true
    } else {
      fail("usage", "알 수 없는 인자다. --help를 참고하라")
    }
  }

  if (list) {
    if (fork) fail("usage", "--fork 와 --list 는 함께 쓸 수 없다")
    const rows = listHistory()
    if (rows.length === 0) {
      process.stdout.write("저장된 세션이 없다.\n")
      return
    }
    for (const row of rows) {
      const when = new Date(row.updatedAt || row.createdAt).toISOString()
      process.stdout.write(`${row.id}\t${row.status}\t${when}\t${row.messages}개\t${row.cwd || "-"}\n`)
    }
    return
  }

  if (byLast && sessionId) fail("usage", "--last 와 --session 은 함께 쓸 수 없다")
  const loaded = sessionId ? loadHistory(sessionId) : latestHistory()
  if (!loaded) fail("usage", sessionId ? `세션을 찾을 수 없다: ${sessionId}` : "저장된 세션이 없다")

  const cwd = loaded.cwd && existsSync(loaded.cwd) ? loaded.cwd : process.cwd()
  const target = fork
    ? forkHistory(loaded.id, cwd)
    : loaded.source === "legacy"
      ? (importLegacyHistory(loaded.id, cwd) ?? loaded)
      : loaded
  const store = createHistoryStore(cwd, target.id)
  // run 이력의 인공 시스템 프롬프트는 대화형 세션에 물려주지 않는다.
  const history = target.messages.filter((message) => message.role !== "system")
  try {
    await launchSession({
      name: name ?? `resume-${process.pid}`,
      cwd,
      history,
      onAppend: (message) => store.persist(message),
      forceTui,
      forceNoTui,
    })
    store.setStatus("closed")
  } catch (error) {
    store.setStatus("error")
    throw error
  } finally {
    store.close()
  }
}

function commandSessions(): void {
  const peers = listPeers().map((p) => p.info)
  if (peers.length === 0) {
    process.stdout.write("실행 중인 세션이 없다.\n")
    return
  }
  for (const p of peers) {
    process.stdout.write(`${p.name}\t${p.status}\t${p.id}\t${p.cwd}\n`)
  }
}

async function commandSend(): Promise<void> {
  fail("usage", "메시지 보내기는 세션 안에서 /send 로 수행한다. 세션을 열려면 session 명령을 사용하라")
}

function main(argv: string[]): void | Promise<void> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE + "\n")
    return
  }
  const [command, ...rest] = argv
  switch (command) {
    case "run": {
      if (rest.length === 0) fail("usage", "파일 이름이 필요하다")
      if (rest.length > 2) fail("usage", "인자가 너무 많다")
      const filename = validateFilename(rest[0] as string)
      const prompt = validatePrompt(rest[1])
      return run(filename, prompt)
    }
    case "session":
      return commandSession(rest)
    case "resume":
      return commandResume(rest)
    case "sessions":
      commandSessions()
      return
    case "send":
      return commandSend()
    default:
      fail("usage", "알 수 없는 명령이다. --help를 참고하라")
  }
}

if (import.meta.main) {
  process.umask(0o077)
  try {
    const result = main(process.argv.slice(2))
    if (result instanceof Promise) {
      result.catch((error: unknown) => {
        const reason = safeErrorReason(error)
        process.stderr.write(`croakcode-next: ${reason}\n`)
        process.exitCode = 1
      })
    }
  } catch (error) {
    const reason = safeErrorReason(error)
    process.stderr.write(`croakcode-next: ${reason}\n`)
    process.exitCode = 1
  }
}
