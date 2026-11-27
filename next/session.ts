import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import { homedir } from "node:os"
import { join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { authorizeTool, openGate, type Gate } from "./gate"
import { chatTurn, type Call, type Message } from "./chat"
import { editFileBounded, readFileBounded, SafeError, validateFilename, validateWriteTarget, writeFileBounded } from "./fsafe"
import {
  clampOutput,
  findFiles,
  grepFiles,
  listDir,
  MAX_FIND_RESULTS,
  MAX_GREP_MATCHES,
  MAX_LIST_ENTRIES,
} from "./scan"
import {
  listPeers,
  openInbox,
  resolvePeer,
  sendMessage,
  type InboundMessage,
  type Inbox,
  type PeerInfo,
} from "./peers"
import { addSub, loadHeld, loadSettings, loadSubs, saveHeld, saveSettings } from "./settings"
import type { Inbound } from "./paths"

const NOTIFY_TTL_MS = 12 * 60 * 60 * 1000
const MAX_NAME_LEN = 64

export class SessionError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

import type { Tui } from "./tui"

export type SessionOptions = {
  name: string
  cwd?: string
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  /** 테스트용: 게이트를 주입할 수 있다. */
  gate?: Gate
  /** 이어갈 대화 이력(재개 시). */
  history?: Message[]
  /** 새로 생성된 메시지를 받는다(이력 영속용). */
  onAppend?: (message: Message) => void
  /** 지정하면 라인 REPL 대신 전체화면 TUI로 출력/입력을 처리한다. */
  tui?: Tui
}


/** 세션 메시징 도구 정의(모델에 보여줄 스키마). */
export const SESSION_TOOLS: unknown[] = [
  {
    type: "function",
    function: {
      name: "ListAgents",
      description: "현재 같은 사용자가 실행 중인 다른 세션 목록(이름, 상태, 작업 디렉터리)을 돌려준다.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "SendMessage",
      description: "다른 세션에 짧은 텍스트 메시지를 보낸다. to에는 세션 이름이나 id를 넣는다.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "대상 세션 이름 또는 id" },
          text: { type: "string", description: "보낼 메시지 본문" },
        },
        required: ["to", "text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "현재 디렉터리의 최상위 짧은 텍스트 파일 하나를 읽는다(허가 필요).",
      parameters: {
        type: "object",
        properties: { filePath: { type: "string", description: "최상위 파일 이름(경로 구분자 불가)" } },
        required: ["filePath"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description:
        "현재 디렉터리 안의 텍스트 파일을 새로 쓰거나 덮어쓴다(허가 필요). 상위 디렉터리가 있어야 하고, 비밀 경로·VCS 내부·심볼릭 링크는 거부된다.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "현재 디렉터리 기준 상대 경로" },
          content: { type: "string", description: "저장할 전체 내용" },
        },
        required: ["filePath", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit",
      description:
        "현재 디렉터리 안의 텍스트 파일에서 oldString을 newString으로 바꾼다(허가 필요). 일치가 여러 곳이면 replaceAll=true가 필요하다.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "현재 디렉터리 기준 상대 경로" },
          oldString: { type: "string", description: "찾을 문자열(비어 있으면 안 됨)" },
          newString: { type: "string", description: "바꿀 문자열" },
          replaceAll: { type: "boolean", description: "모든 일치를 바꿀지 여부(기본 false)" },
        },
        required: ["filePath", "oldString", "newString"],
        additionalProperties: false,
      },
    },
  },
]

function normalizeName(raw: string): string {
  const name = raw.trim()
  if (!name) throw new SessionError("name_invalid", "세션 이름이 비어 있다")
  if (name.length > MAX_NAME_LEN) throw new SessionError("name_invalid", "세션 이름이 너무 길다")
  if (/[\n\r\0]/.test(name)) throw new SessionError("name_invalid", "세션 이름에 허용되지 않는 문자가 있다")
  return name
}

function hasPolicyDeny(sid: string, tool: string): boolean {
  if (process.env.CROAKCODE_ADMIN_POLICY_FILE) return true
  const file =
    process.env.CROAK_TOOL_POLICY_FILE ||
    join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "croak", "tool-policy.json")
  if (!existsSync(file)) return false
  let policy: Record<string, unknown>
  try {
    policy = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
  } catch {
    return false
  }
  if (!policy || typeof policy !== "object") return false
  const deny = Array.isArray(policy.deny) ? policy.deny : []
  const sessions =
    policy.sessions && typeof policy.sessions === "object" && !Array.isArray(policy.sessions)
      ? (policy.sessions as Record<string, unknown>)
      : {}
  const patterns = [...deny] as unknown[]
  for (const key of ["*", sid]) {
    const list = sessions[key]
    if (Array.isArray(list)) patterns.push(...list)
  }
  return patterns.some((p) => p === "*" || p === tool)
}

export type Session = {
  id: string
  name: string
  /** REPL을 종료한다. */
  stop(): Promise<void>
  /** 외부 신호로 입력을 닫는다. */
  interrupt(): Promise<void>
  /** 테스트용: 한 줄 입력 처리의 결과를 기다린다. */
  handleLine(line: string): Promise<void>
  /** 현재까지 표시된 출력 버퍼(테스트용). */
  transcript(): string[]
}

export async function startSession(options: SessionOptions): Promise<Session> {
  const cwd = options.cwd ?? process.cwd()
  const token = randomUUID()
  const settings = loadSettings()
  let inbound: Inbound = settings.inbound
  let gate: Gate | null = options.gate ?? null
  const lines: string[] = []
  let history: Message[] = options.history ? [...options.history] : []
  let current: InboundMessage | null = null

  const emit = (line: string) => {
    lines.push(line)
    if (options.tui) options.tui.writeLine(line)
    else options.output.write(`${line}\n`)
  }

  const syncStatus = (activity?: "idle" | "busy") => {
    if (!options.tui) return
    let peers = 0
    try {
      peers = listPeers().length
    } catch {
      peers = 0
    }
    options.tui.setStatus({
      name: heldName,
      inbound,
      activity: activity ?? (inbox.info.status === "busy" ? "busy" : "idle"),
      peers,
    })
  }

  const getGate = (): Gate => {
    if (!gate) gate = openGate()
    return gate
  }

  let heldName = normalizeName(options.name)
  if (listPeers().some((p) => p.info.name === heldName)) {
    throw new SessionError("name_taken", `이미 사용 중인 세션 이름이다: ${heldName}`)
  }
  const inbox: Inbox = await openInbox({ name: heldName, cwd, token })
  let held = loadHeld(heldName)
  if (history.length > 0) emit(`이전 대화 ${history.length}개 메시지를 이어간다.`)

  const renderInbound = (message: InboundMessage) => {
    emit(`[${message.fromName}] ${message.text}`)
  }

  const deliverByRule = (message: InboundMessage) => {
    if (inbound === "refuse") {
      emit(`(거부됨) ${message.fromName}: ${message.text.slice(0, 80)}`)
      return
    }
    if (inbound === "accept") {
      current = message
      renderInbound(message)
      return
    }
    // hold: 파일에 보관하고 미리보기만 표시한다.
    current = message
    held.push(message)
    saveHeld(heldName, held)
    emit(`(보류 ${held.length}) ${message.fromName}: ${message.text.slice(0, 80)}`)
  }

  inbox.onMessage((message) => {
    deliverByRule(message)
  })

  // idle 전환 시 이 세션에 구독한 피어들에게 알린다.
  const announceIdle = async () => {
    const subs = loadSubs(inbox.info.id).filter((s) => s.expiresAt > Date.now())
    for (const sub of subs) {
      const target = listPeers()
        .map((p) => p.info)
        .find((p) => p.id === sub.by)
      if (!target) continue
      try {
        await sendMessage({ from: inbox.info, token, to: target, text: "지금 idle 상태다. 메시지를 보내도 된다." })
      } catch {
        // 전달 실패는 무시한다
      }
    }
  }

  const executeTool = async (call: Call): Promise<string> => {
    let args: Record<string, unknown>
    try {
      args = JSON.parse(call.function.arguments) as Record<string, unknown>
    } catch {
      return "오류: 도구 인자가 JSON이 아니다"
    }
    if (call.function.name === "ListAgents") {
      const peers = listPeers()
        .map((p) => p.info)
        .filter((p) => p.id !== inbox.info.id)
      if (peers.length === 0) return "다른 세션이 없다."
      return peers
        .map((p) => `- ${p.name} (${p.id}, ${p.status}, ${p.cwd})`)
        .join("\n")
    }
    if (call.function.name === "SendMessage") {
      return await sendTo(String(args.to ?? ""), String(args.text ?? ""))
    }
    if (call.function.name === "read") {
      return await readTool(String(args.filePath ?? ""))
    }
    if (call.function.name === "write") {
      return await writeTool(args.filePath, args.content)
    }
    if (call.function.name === "edit") {
      return await editTool(args.filePath, args.oldString, args.newString, args.replaceAll)
    }
    return "오류: 알 수 없는 도구다"
  }

  const sendTo = async (to: string, text: string): Promise<string> => {
    if (!to.trim()) return "오류: 대상 세션이 비어 있다"
    if (!text.trim()) return "오류: 메시지가 비어 있다"
    let target: PeerInfo | null
    try {
      target = resolvePeer(to.trim())
    } catch (error) {
      if (error instanceof Error && error.message) return `오류: ${error.message}`
      return "오류: 대상 세션을 찾을 수 없다"
    }
    if (!target) return `오류: 세션 '${to}'를 찾을 수 없다`
    if (target.id === inbox.info.id) return "오류: 자기 자신에게는 보낼 수 없다"
    try {
      await sendMessage({ from: inbox.info, token, to: target, text })
    } catch (error) {
      return `오류: ${(error as Error).message}`
    }
    return `보냄: ${target.name}`
  }

  const readTool = async (filePath: string): Promise<string> => {
    if (hasPolicyDeny(inbox.info.id, "read")) return "오류: 로컬 정책이 read 도구를 금지한다"
    try {
      validateFilename(filePath)
    } catch (error) {
      return `오류: ${(error as Error).message}`
    }
    const rid = `run_${randomUUID()}`
    const pid = `apr_${randomUUID()}`
    try {
      await authorizeTool(getGate(), { sid: inbox.info.id, rid, pid }, "read", { filePath }, () => true)
    } catch (error) {
      return `오류: 허가 실패: ${(error as Error).message}`
    }
    try {
      return readFileBounded(filePath)
    } catch (error) {
      return `오류: ${(error as Error).message}`
    }
  }

  const writeTool = async (rawPath: unknown, content: unknown): Promise<string> => {
    if (hasPolicyDeny(inbox.info.id, "write")) return "오류: 로컬 정책이 write 도구를 금지한다"
    const filePath = typeof rawPath === "string" ? rawPath.trim() : ""
    if (!filePath) return "오류: filePath가 비어 있다"
    if (typeof content !== "string") return "오류: content가 문자열이 아니다"
    try {
      validateWriteTarget(cwd, filePath, content)
    } catch (error) {
      return `오류: ${(error as Error).message}`
    }
    const rid = `run_${randomUUID()}`
    const pid = `apr_${randomUUID()}`
    try {
      await authorizeTool(getGate(), { sid: inbox.info.id, rid, pid }, "write", { filePath, content }, () => true)
    } catch (error) {
      return `오류: 허가 실패: ${(error as Error).message}`
    }
    try {
      const bytes = writeFileBounded(cwd, filePath, content)
      return `파일을 썼다: ${filePath} (${bytes} bytes)`
    } catch (error) {
      return `오류: ${(error as Error).message}`
    }
  }

  const editTool = async (rawPath: unknown, oldString: unknown, newString: unknown, replaceAll: unknown): Promise<string> => {
    if (hasPolicyDeny(inbox.info.id, "edit")) return "오류: 로컬 정책이 edit 도구를 금지한다"
    const filePath = typeof rawPath === "string" ? rawPath.trim() : ""
    if (!filePath) return "오류: filePath가 비어 있다"
    if (typeof oldString !== "string" || oldString.length === 0) return "오류: oldString이 비어 있거나 문자열이 아니다"
    if (typeof newString !== "string") return "오류: newString이 문자열이 아니다"
    if (replaceAll !== undefined && typeof replaceAll !== "boolean") return "오류: replaceAll은 boolean이어야 한다"
    try {
      validateWriteTarget(cwd, filePath, "")
    } catch (error) {
      return `오류: ${(error as Error).message}`
    }
    const rid = `run_${randomUUID()}`
    const pid = `apr_${randomUUID()}`
    const args = { filePath, oldString, newString, replaceAll: replaceAll === true }
    try {
      await authorizeTool(getGate(), { sid: inbox.info.id, rid, pid }, "edit", args, () => true)
    } catch (error) {
      return `오류: 허가 실패: ${(error as Error).message}`
    }
    try {
      const count = editFileBounded(cwd, filePath, oldString, newString, replaceAll === true)
      return `${count}곳을 바꿨다: ${filePath}`
    } catch (error) {
      return `오류: ${(error as Error).message}`
    }
  }

  const chat = async (text: string): Promise<void> => {
    inbox.setStatus("busy")
    syncStatus("busy")
    try {
      const user: Message = { role: "user", content: text }
      const before = history.length
      history.push(user)
      const result = await chatTurn(getGate(), { sid: inbox.info.id, rid: `run_${randomUUID()}` }, history, SESSION_TOOLS, executeTool)
      const produced = result.messages.slice(before)
      history = result.messages
      if (options.onAppend) {
        for (const message of produced) {
          try {
            options.onAppend(message)
          } catch {
            // 이력 저장 실패가 대화를 막지 않는다
          }
        }
      }
      emit(`(나) ${result.text}`)
    } catch (error) {
      const reason = error instanceof SafeError ? error.code : ((error as { message?: string }).message ?? "오류")
      emit(`(오류) ${reason}`)
      history.pop()
    } finally {
      inbox.setStatus("idle")
      syncStatus("idle")
      await announceIdle()
    }
  }

  const showPeers = () => {
    const peers = listPeers().map((p) => p.info)
    if (peers.length <= 1) {
      emit("다른 세션이 없다.")
      return
    }
    for (const p of peers) {
      const self = p.id === inbox.info.id ? " (나)" : ""
      emit(`${p.name}${self} — ${p.status} — ${p.cwd}`)
    }
  }

  const showHeld = () => {
    if (held.length === 0) {
      emit("보류 중인 메시지가 없다.")
      return
    }
    held.forEach((m, i) => emit(`[${i + 1}] ${m.fromName}: ${m.text}`))
  }

  // 사용자가 직접 실행하는 읽기 전용 탐색 명령. 모델 도구/permit과 무관하다.
  const emitBlock = (text: string): void => {
    const clamped = clampOutput(text)
    for (const line of clamped.text.split("\n")) emit(line)
    if (clamped.truncated) emit("... (출력이 길어 잘렸다)")
  }

  const scanFail = (error: unknown): void => {
    emit(`오류: ${(error as Error).message}`)
  }

  const listCommand = (dir: string): void => {
    try {
      const result = listDir(cwd, dir || ".")
      if (result.entries.length === 0) {
        emit("(비어 있음)")
        return
      }
      const more = result.truncated ? `\n... (${MAX_LIST_ENTRIES}개까지만 표시)` : ""
      emitBlock(result.entries.join("\n") + more)
    } catch (error) {
      scanFail(error)
    }
  }

  const findCommand = (glob: string): void => {
    if (!glob) {
      emit("사용법: /find <glob>   예: /find **/*.ts")
      return
    }
    try {
      const result = findFiles(cwd, glob)
      if (result.files.length === 0) {
        emit("일치하는 파일이 없다.")
        return
      }
      const more = result.truncated ? `\n... (${MAX_FIND_RESULTS}개까지만 표시)` : ""
      emitBlock(result.files.join("\n") + more)
    } catch (error) {
      scanFail(error)
    }
  }

  const grepCommand = (argText: string): void => {
    const [pattern, ...rest] = argText.split(/\s+/).filter(Boolean)
    if (!pattern) {
      emit("사용법: /grep <검색어> [include-glob]   예: /grep TODO **/*.ts")
      return
    }
    try {
      const result = grepFiles(cwd, pattern, rest.join(" "))
      if (result.hits.length === 0) {
        emit(`일치 항목이 없다. (${result.scanned}개 파일 검사)`)
        return
      }
      const body = result.hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n")
      const more = result.truncated ? `\n... (${MAX_GREP_MATCHES}건까지만 표시)` : ""
      emitBlock(body + more)
    } catch (error) {
      scanFail(error)
    }
  }

  // /held 의 하위 명령. 인자가 없으면 목록만 보여준다.
  const heldCommand = (args: string[]) => {
    const sub = args[0]
    if (!sub) {
      showHeld()
      return
    }
    if (sub === "clear") {
      if (held.length === 0) {
        emit("보류 중인 메시지가 없다.")
        return
      }
      const count = held.length
      held = []
      saveHeld(heldName, held)
      emit(`보류 메시지 ${count}건을 모두 비웠다.`)
      return
    }
    if (sub === "rm") {
      const index = Number(args[1])
      if (!Number.isInteger(index) || index < 1 || index > held.length) {
        emit("사용법: /held rm <번호>  (/held 목록의 [번호])")
        return
      }
      const [removed] = held.splice(index - 1, 1)
      saveHeld(heldName, held)
      emit(`삭제: [${index}] ${removed?.fromName}: ${removed?.text.slice(0, 80) ?? ""}`)
      return
    }
    if (sub === "find") {
      const needle = args.slice(1).join(" ").trim().toLowerCase()
      if (!needle) {
        emit("사용법: /held find <문자열>")
        return
      }
      const hits = held
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => m.text.toLowerCase().includes(needle) || m.fromName.toLowerCase().includes(needle))
      if (hits.length === 0) {
        emit(`'${needle}' 와 일치하는 보류 메시지가 없다.`)
        return
      }
      for (const { m, i } of hits) emit(`[${i + 1}] ${m.fromName}: ${m.text}`)
      return
    }
    emit("사용법: /held [clear|rm <번호>|find <문자열>]")
  }

  const viewAll = (target?: string) => {
    const list = target ? held.filter((m) => m.id === target) : held.length > 0 ? held : current ? [current] : []
    if (list.length === 0) {
      emit("표시할 메시지가 없다.")
      return
    }
    const picked = list[list.length - 1] as InboundMessage
    if (options.tui) {
      const header = `보낸이: ${picked.fromName} (${picked.from})  시각: ${new Date(picked.ts).toISOString()}`
      options.tui.openViewer(header, picked.text)
      return
    }
    for (const m of list) viewMessage(m)
  }

  const viewMessage = (message: InboundMessage) => {
    emit("────────────────────────────")
    emit(`보낸이: ${message.fromName} (${message.from})`)
    emit(`시각: ${new Date(message.ts).toISOString()}`)
    emit("────────────────────────────")
    for (const line of message.text.split("\n")) emit(line)
    emit("────────────────────────────")
  }

  const setInbound = (value: string) => {
    if (value !== "accept" && value !== "hold" && value !== "refuse") {
      emit("사용법: /inbound accept|hold|refuse")
      return
    }
    inbound = value
    saveSettings({ inbound })
    syncStatus()
    emit(`수신 규칙: ${inbound}`)
    if (inbound === "accept" && held.length > 0) {
      const queued = held.splice(0)
      saveHeld(heldName, held)
      for (const message of queued) renderInbound(message)
    }
  }

  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    saveHeld(heldName, held)
    await inbox.close()
    resolveClosed()
  }

  const handleLine = async (raw: string): Promise<void> => {
    const line = raw.replace(/\r$/, "")
    const trimmed = line.trim()
    if (!trimmed) return
    if (trimmed[0] !== "/") {
      await chat(trimmed)
      return
    }
    const [command, ...rest] = trimmed.slice(1).split(/\s+/)
    const argText = trimmed.slice(1 + (command?.length ?? 0)).trim()

    switch (command) {
      case "quit":
      case "exit":
        await shutdown()
        return
      case "help":
        emit("명령: /send <세션> <메시지>, /peers, /held [clear|rm <번호>|find <문자열>], /view [id], /rename <이름>, /inbound <accept|hold|refuse>, /notify <세션>, /quit")
        emit("탐색: /ls [디렉터리], /find <glob>, /grep <검색어> [include-glob]")
        emit("슬래시 없이 입력하면 모델과 대화한다.")
        return
      case "peers":
        showPeers()
        return
      case "ls":
        listCommand(argText)
        return
      case "find":
        findCommand(argText)
        return
      case "grep":
        grepCommand(argText)
        return
      case "held":
        heldCommand(rest)
        return
      case "view":
        viewAll(rest[0])
        return
      case "send": {
        const target = rest[0]
        const text = argText.slice((target?.length ?? 0)).trim()
        if (!target || !text) {
          emit("사용법: /send <세션> <메시지>")
          return
        }
        emit(await sendTo(target, text))
        return
      }
      case "rename": {
        try {
          const name = normalizeName(argText)
          if (listPeers().some((p) => p.info.name === name && p.info.id !== inbox.info.id)) {
            throw new SessionError("name_taken", `이미 사용 중인 세션 이름이다: ${name}`)
          }
          inbox.rename(name)
          // 보류 큐를 새 이름으로 옮긴다.
          const moved = held
          saveHeld(heldName, [])
          heldName = name
          saveHeld(heldName, moved)
          emit(`이름 변경: ${name}`)
        } catch (error) {
          emit(`오류: ${(error as Error).message}`)
        }
        return
      }
      case "inbound":
        setInbound(rest[0] ?? "")
        return
      case "notify": {
        // /notify <세션> — 그 세션이 idle이 되면 알리도록 12시간 구독한다.
        const target = rest[0]
        if (!target) {
          emit("사용법: /notify <세션>")
          return
        }
        const peers = listPeers().map((p) => p.info)
        const found = peers.find((p) => p.name === target || p.id === target)
        if (!found) {
          emit(`오류: 세션 '${target}'를 찾을 수 없다`)
          return
        }
        addSub(found.id, inbox.info.id, Date.now() + NOTIFY_TTL_MS)
        emit(`${found.name} 세션의 idle 알림을 12시간 구독했다.`)
        return
      }
      default:
        emit(`알 수 없는 명령이다: /${command ?? ""} (도움말: /help)`)
    }
  }

  let resolveClosed: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  let loop: Promise<void> = Promise.resolve()
  let rl: ReturnType<typeof createInterface> | null = null

  if (options.tui) {
    // TUI가 입력을 대신 처리한다. /quit → shutdown 이 closed를 완료한다.
    loop = closed
  } else {
    rl = createInterface({ input: options.input, terminal: false })
    const lineReader = rl
    loop = (async () => {
      for await (const line of lineReader) {
        await handleLine(line)
        if (stopping) break
      }
      lineReader.close()
      await shutdown()
    })()
  }

  const session: Session = {
    id: inbox.info.id,
    name: inbox.info.name,
    // 입력이 끝나거나 /quit 이 처리되어 루프가 끝날 때까지 기다린다.
    async stop() {
      await loop
      await closed
    },
    // 외부 신호(SIGINT 등)로 입력을 닫아 루프를 끝낸다.
    async interrupt() {
      if (rl) rl.close()
      await shutdown()
      await loop
      await closed
    },
    handleLine,
    transcript: () => [...lines],
  }

  emit(`세션 시작: ${inbox.info.name} (${inbox.info.id}) 수신 규칙: ${inbound}`)
  if (held.length > 0) emit(`보류 중인 메시지 ${held.length}건이 있다. /held 로 확인하라.`)
  syncStatus("idle")

  return session
}

export { normalizeName }
