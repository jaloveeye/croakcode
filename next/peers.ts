import { randomUUID } from "node:crypto"
import { connect, createServer, type Server, type Socket } from "node:net"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { peersDir, socketDir } from "./paths"

export const MAX_MESSAGE_CHARS = 1_000_000
const MAX_PENDING = 100
const RATE_WINDOW_MS = 10_000
const RATE_MAX = 30
const AUTH_TIMEOUT_MS = 30_000
const MAX_FRAME_BYTES = MAX_MESSAGE_CHARS + 4_096

export type PeerInfo = {
  id: string
  name: string
  socket: string
  cwd: string
  pid: number
  startedAt: number
  status: "idle" | "busy"
}

export type InboundMessage = {
  id: string
  from: string
  fromName: string
  text: string
  ts: number
}

type WireMessage = InboundMessage & { type: "message" }
type WireAuth = { type: "auth"; token: string }
type Wire = WireMessage | WireAuth

export class PeerError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  if (stat.isSymbolicLink()) throw new PeerError("peer_insecure", "소켓/레지스트리 디렉터리가 심볼릭 링크다")
  if (!stat.isDirectory()) throw new PeerError("peer_insecure", "디렉터리가 아니다")
  if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700)
}

function peerFile(id: string): string {
  return join(peersDir(), `${id}.json`)
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** 살아 있는 피어와 그 등록 파일 목록을 돌려준다. 죽은/stale 항목은 정리한다. */
export function listPeers(): Array<{ info: PeerInfo; file: string }> {
  const dir = peersDir()
  if (!existsSync(dir)) return []
  const out: Array<{ info: PeerInfo; file: string }> = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue
    const file = join(dir, entry)
    let info: PeerInfo
    try {
      const stat = lstatSync(file)
      if (stat.isSymbolicLink() || !stat.isFile()) {
        unlinkIfRegular(file)
        continue
      }
      info = JSON.parse(readFileSync(file, "utf8")) as PeerInfo
    } catch {
      unlinkIfRegular(file)
      continue
    }
    if (!info || typeof info.id !== "string" || typeof info.socket !== "string") {
      unlinkIfRegular(file)
      continue
    }
    if (!pidAlive(info.pid) || !existsSync(info.socket)) {
      unlinkIfRegular(file)
      continue
    }
    out.push({ info, file })
  }
  return out.sort((a, b) => a.info.startedAt - b.info.startedAt)
}

function unlinkIfRegular(file: string): void {
  try {
    const stat = lstatSync(file)
    if (!stat.isSymbolicLink()) unlinkSync(file)
  } catch {
    // 이미 없으면 무시한다
  }
}

/** 이름으로 단일 피어를 찾는다. 없으면 null, 중복이면 후보 목록과 함께 오류. */
export function resolvePeer(target: string): PeerInfo | null {
  const peers = listPeers().map((p) => p.info)
  const byId = peers.find((p) => p.id === target)
  if (byId) return byId
  const named = peers.filter((p) => p.name === target)
  if (named.length === 0) return null
  if (named.length > 1) throw new PeerError("peer_ambiguous", `이름 "${target}"에 응답하는 세션이 여러 개다`)
  return named[0] as PeerInfo
}

export type Inbox = {
  info: PeerInfo
  /** 보류 중이거나 표시할 메시지를 꺼낸다(수신 처리에서 호출). */
  onMessage: (fn: (message: InboundMessage) => void) => void
  /** idle↔busy 상태를 등록 파일에 반영한다. */
  setStatus(status: "idle" | "busy"): void
  rename(name: string): void
  close(): Promise<void>
}

export type InboxOptions = {
  name: string
  cwd: string
  token: string
}

/** 세션 받은편지함 소켓을 열고 레지스트리에 등록한다. */
export async function openInbox(options: InboxOptions): Promise<Inbox> {
  ensurePrivateDir(peersDir())
  ensurePrivateDir(socketDir())

  const id = `ses_${randomUUID()}`
  const socket = join(socketDir(), `${id}.sock`)
  if (existsSync(socket)) unlinkIfRegular(socket)

  const info: PeerInfo = {
    id,
    name: options.name,
    socket,
    cwd: options.cwd,
    pid: process.pid,
    startedAt: Date.now(),
    status: "idle",
  }
  writePeer(info)

  let handler: ((message: InboundMessage) => void) | null = null
  const pending: InboundMessage[] = []
  const recent: number[] = []

  const deliver = (message: InboundMessage) => {
    // 송신자 id는 살아 있는 피어여야 한다. 표시 이름은 레지스트리 값을 신뢰한다.
    const sender = listPeers()
      .map((p) => p.info)
      .find((p) => p.id === message.from)
    if (!sender) return
    const verified: InboundMessage = { ...message, fromName: sender.name }
    if (handler) handler(verified)
    else {
      pending.push(verified)
      while (pending.length > MAX_PENDING) pending.shift()
    }
  }

  const rateOk = (): boolean => {
    const now = Date.now()
    while (recent.length > 0 && now - (recent[0] as number) > RATE_WINDOW_MS) recent.shift()
    if (recent.length >= RATE_MAX) return false
    recent.push(now)
    return true
  }

  const server: Server = createServer((conn: Socket) => handleConnection(conn, rateOk, deliver))
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socket, () => {
      try {
        chmodSync(socket, 0o600)
      } catch {
        // 권한 조정 실패는 무시하되 아래에서 다시 시도한다
      }
      resolve()
    })
  })

  return {
    info,
    onMessage(fn) {
      handler = fn
      for (const message of pending.splice(0)) fn(message)
    },
    setStatus(status) {
      info.status = status
      writePeer(info)
    },
    rename(name) {
      info.name = name
      writePeer(info)
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      unlinkIfRegular(socket)
      unlinkIfRegular(peerFile(id))
    },
  }
}

function writePeer(info: PeerInfo): void {
  const file = peerFile(info.id)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 })
  renameSync(tmp, file)
}

function handleConnection(conn: Socket, rateOk: () => boolean, deliver: (message: InboundMessage) => void): void {
  let buffer = ""
  let sawAuth = false
  let closed = false

  const finish = () => {
    if (closed) return
    closed = true
    try {
      conn.end()
    } catch {
      // 이미 닫혔으면 무시한다
    }
  }

  const timer = setTimeout(finish, AUTH_TIMEOUT_MS)

  conn.on("error", () => finish())
  conn.on("close", () => {
    clearTimeout(timer)
    closed = true
  })

  conn.on("data", (chunk: Buffer) => {
    if (closed) return
    buffer += chunk.toString("utf8")
    if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) return finish()
    let index = buffer.indexOf("\n")
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf("\n")
      if (line.trim().length === 0) continue

      let wire: Wire
      try {
        wire = JSON.parse(line) as Wire
      } catch {
        return finish()
      }

      if (!sawAuth) {
        // 인증 줄이 온 뒤에만 메시지를 받는다. 같은 OS 사용자만 소켓에 닿을 수 있다.
        if (wire.type !== "auth" || typeof wire.token !== "string") return finish()
        sawAuth = true
        continue
      }

      if (!rateOk()) return finish()
      if (wire.type !== "message") continue
      const message = sanitize(wire)
      if (!message) {
        finish()
        return
      }
      deliver(message)
      finish()
      return
    }
  })
}

export type SendInput = {
  from: PeerInfo
  token: string
  to: PeerInfo
  text: string
}

/** 대상 세션의 받은편지함 소켓으로 한 메시지를 전달한다. */
export async function sendMessage(input: SendInput): Promise<void> {
  if (Buffer.byteLength(input.text, "utf8") > MAX_MESSAGE_CHARS) {
    throw new PeerError("message_too_large", "메시지가 너무 크다")
  }
  if (!resolvePeer(input.to.id)) throw new PeerError("peer_unavailable", "대상 세션이 더 이상 없다")
  const message: WireMessage = {
    type: "message",
    id: `msg_${randomUUID()}`,
    from: input.from.id,
    fromName: input.from.name,
    text: input.text,
    ts: Date.now(),
  }
  await new Promise<void>((resolve, reject) => {
    const socket = connect(input.to.socket)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new PeerError("peer_unavailable", "대상 세션 소켓에 연결할 수 없다"))
    }, 5_000)
    socket.once("error", (error) => {
      clearTimeout(timer)
      reject(new PeerError("peer_unavailable", `대상 세션에 메시지를 보낼 수 없다: ${(error as Error).message}`))
    })
    socket.once("connect", () => {
      const auth: WireAuth = { type: "auth", token: input.token }
      socket.write(`${JSON.stringify(auth)}\n${JSON.stringify(message)}\n`)
    })
    socket.once("close", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function sanitize(wire: WireMessage): InboundMessage | null {
  if (!wire || typeof wire !== "object") return null
  const { from, fromName, text, id, ts } = wire
  if (typeof from !== "string" || from.length === 0) return null
  if (typeof fromName !== "string") return null
  if (typeof text !== "string" || text.length === 0) return null
  if (text.length > MAX_MESSAGE_CHARS) return null
  const messageID = typeof id === "string" && id.length > 0 ? id : `msg_${randomUUID()}`
  const when = typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now()
  return { id: messageID, from, fromName, text, ts: when }
}
