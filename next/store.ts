import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { dataDir, legacyDbFiles } from "./paths"
import type { Call, Message } from "./chat"

const BUSY_TIMEOUT_MS = 5_000
const LEGACY_TABLES = ["session", "message", "part"] as const

export type SessionStatus = "running" | "busy" | "idle" | "completed" | "error" | "closed"

function ensureColumn(db: Database, table: string, column: string, ddl: string): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
}

/** sessions.db 를 열고 (없으면 만들고) 스키마를 보장한다. 구버전 DB는 컬럼을 추가해 마이그레이션한다. */
export function openDb(): Database {
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
  ensureColumn(db, "sessions", "kind", "kind TEXT NOT NULL DEFAULT 'run'")
  ensureColumn(db, "sessions", "cwd", "cwd TEXT")
  ensureColumn(db, "sessions", "created_at", "created_at INTEGER NOT NULL DEFAULT 0")
  ensureColumn(db, "sessions", "updated_at", "updated_at INTEGER NOT NULL DEFAULT 0")
  ensureColumn(db, "sessions", "parent_id", "parent_id TEXT")
  return db
}

/**
 * 기존 croakcode(upstream)의 croakcode.db 를 읽기 전용으로 연다.
 * 파일이 없거나 기대하는 session/message/part 테이블이 없으면 null.
 */
function openLegacyDb(): Database | null {
  for (const file of legacyDbFiles()) {
    if (!existsSync(file)) continue
    let db: Database
    try {
      db = new Database(file, { readonly: true })
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    } catch {
      continue
    }
    try {
      const tables = new Set(
        (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
          (row) => row.name,
        ),
      )
      if (!LEGACY_TABLES.every((name) => tables.has(name))) {
        db.close()
        continue
      }
      return db
    } catch {
      db.close()
      continue
    }
  }
  return null
}

export type Store = {
  sessionId: string
  persist(body: Message): void
  setStatus(status: "running" | "completed" | "error", error?: string | null): void
  claim(nonce: string, exp: number): boolean
  close(): void
}

/** `run` 한 번 실행을 기록하는 저장소. */
export function createStore(): Store {
  const db = openDb()
  const sessionId = `ses_${randomUUID()}`
  const now = Date.now()
  db.query(
    "INSERT INTO sessions (id, status, error, kind, cwd, created_at, updated_at) VALUES (?, 'running', NULL, 'run', ?, ?, ?)",
  ).run(sessionId, process.cwd(), now, now)
  let seq = 0
  const insert = db.query("INSERT INTO messages (session_id, seq, body) VALUES (?, ?, ?)")
  const status = db.query("UPDATE sessions SET status = ?, error = ?, updated_at = ? WHERE id = ?")
  const nonce = db.query("INSERT OR IGNORE INTO nonces (nonce, exp) VALUES (?, ?)")
  const prune = db.query("DELETE FROM nonces WHERE exp < ?")
  return {
    sessionId,
    persist(body: Message) {
      insert.run(sessionId, seq, JSON.stringify(body))
      seq += 1
    },
    setStatus(next, error = null) {
      status.run(next, error, Date.now(), sessionId)
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

export type HistoryStore = {
  id: string
  persist(body: Message): void
  setStatus(status: SessionStatus): void
  close(): void
}

/** 대화형 세션 이력을 기록한다. id를 주면 기존 세션을 이어 쓴다. */
export function createHistoryStore(cwd: string, id?: string): HistoryStore {
  const db = openDb()
  const now = Date.now()
  let sessionId = id
  let seq = 0
  if (sessionId) {
    const row = db.query("SELECT id FROM sessions WHERE id = ?").get(sessionId) as { id: string } | null
    if (!row) {
      db.close()
      throw new Error("history_not_found")
    }
    const max = db.query("SELECT COALESCE(MAX(seq), -1) AS m FROM messages WHERE session_id = ?").get(sessionId) as {
      m: number
    }
    seq = max.m + 1
    db.query("UPDATE sessions SET status = 'running', error = NULL, updated_at = ? WHERE id = ?").run(now, sessionId)
  } else {
    sessionId = `ses_${randomUUID()}`
    db.query(
      "INSERT INTO sessions (id, status, error, kind, cwd, created_at, updated_at) VALUES (?, 'running', NULL, 'session', ?, ?, ?)",
    ).run(sessionId, cwd, now, now)
  }
  const insert = db.query("INSERT INTO messages (session_id, seq, body) VALUES (?, ?, ?)")
  const status = db.query("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
  return {
    id: sessionId,
    persist(body: Message) {
      insert.run(sessionId, seq, JSON.stringify(body))
      seq += 1
    },
    setStatus(next) {
      status.run(next, Date.now(), sessionId)
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

export type HistoryKind = "session" | "run"
export type HistorySource = "next" | "legacy"

export type HistoryMeta = {
  id: string
  status: string
  cwd: string
  createdAt: number
  updatedAt: number
  messages: number
  kind: HistoryKind
  parentId: string | null
  source: HistorySource
}

export type LoadedHistory = {
  id: string
  status: string
  cwd: string
  messages: Message[]
  kind: HistoryKind
  parentId: string | null
  source: HistorySource
}

function listNextHistory(limit: number): HistoryMeta[] {
  const db = openDb()
  try {
    return db
      .query(
        `SELECT s.id, s.status, COALESCE(s.cwd, '') AS cwd, s.created_at AS createdAt, s.updated_at AS updatedAt,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messages,
                s.kind AS kind, s.parent_id AS parentId
           FROM sessions s
          WHERE s.kind IN ('session', 'run')
          ORDER BY s.updated_at DESC, s.rowid DESC
          LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({ ...(row as Omit<HistoryMeta, "source">), source: "next" as const }))
  } finally {
    db.close()
  }
}

function listLegacyHistory(limit: number): HistoryMeta[] {
  const db = openLegacyDb()
  if (!db) return []
  try {
    const rows = db
      .query(
        `SELECT s.id, COALESCE(s.directory, '') AS cwd, s.time_created AS createdAt, s.time_updated AS updatedAt,
                (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS messages
           FROM session s
          ORDER BY s.time_updated DESC
          LIMIT ?`,
      )
      .all(limit) as Array<Omit<HistoryMeta, "status" | "kind" | "parentId" | "source">>
    return rows.map((row) => ({
      ...row,
      status: "closed",
      kind: "session",
      parentId: null,
      source: "legacy",
    }))
  } catch {
    return []
  } finally {
    db.close()
  }
}

/** next/와 기존 croakcode DB의 세션을 최신순으로 합친다. 같은 id는 next/를 우선한다. */
export function listHistory(limit = 20): HistoryMeta[] {
  const seen = new Set<string>()
  const merged: HistoryMeta[] = []
  for (const row of [...listNextHistory(limit), ...listLegacyHistory(limit)]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    merged.push(row)
  }
  return merged.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)).slice(0, limit)
}

function loadNextHistory(id: string): LoadedHistory | null {
  const db = openDb()
  try {
    const row = db
      .query(
        `SELECT id, status, COALESCE(cwd, '') AS cwd, kind, parent_id AS parentId
           FROM sessions WHERE id = ? AND kind IN ('session', 'run')`,
      )
      .get(id) as { id: string; status: string; cwd: string; kind: HistoryKind; parentId: string | null } | null
    if (!row) return null
    const rows = db.query("SELECT body FROM messages WHERE session_id = ? ORDER BY seq").all(id) as Array<{
      body: string
    }>
    const messages: Message[] = []
    for (const item of rows) {
      try {
        messages.push(JSON.parse(item.body) as Message)
      } catch {
        // 손상된 메시지는 건너뛴다
      }
    }
    return { ...row, messages, source: "next" }
  } finally {
    db.close()
  }
}

type LegacyPart = {
  type?: unknown
  text?: unknown
  callID?: unknown
  tool?: unknown
  state?: { status?: unknown; input?: unknown; output?: unknown; error?: unknown } | null
}

type LegacyMessageData = { role?: unknown; content?: unknown }

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function legacyToolOutput(part: LegacyPart): string {
  const state = part.state ?? {}
  if (typeof state.output === "string") return state.output
  if (state.output !== undefined) {
    try {
      return JSON.stringify(state.output)
    } catch {
      return String(state.output)
    }
  }
  if (typeof state.error === "string") return `오류: ${state.error}`
  if (state.status === "running" || state.status === "pending") return "[croak] 도구가 완료되지 않았다."
  return "[croak] 도구 결과가 없다."
}

function legacyParts(db: Database, sessionId: string): Map<string, LegacyPart[]> {
  const byMessage = new Map<string, LegacyPart[]>()
  const rows = db
    .query("SELECT message_id AS messageId, data FROM part WHERE session_id = ? ORDER BY time_created, id")
    .all(sessionId) as Array<{ messageId: string; data: string }>
  for (const row of rows) {
    const parsed = parseJson(row.data)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
    const list = byMessage.get(row.messageId) ?? []
    list.push(parsed as LegacyPart)
    byMessage.set(row.messageId, list)
  }
  return byMessage
}

function legacyMessages(db: Database, sessionId: string): Message[] {
  const parts = legacyParts(db, sessionId)
  const rows = db
    .query("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id")
    .all(sessionId) as Array<{ id: string; data: string }>
  const messages: Message[] = []

  for (const row of rows) {
    const parsed = parseJson(row.data)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
    const data = parsed as LegacyMessageData
    const role = data.role
    if (role !== "user" && role !== "assistant" && role !== "system") continue

    const list = parts.get(row.id) ?? []
    const text = list
      .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
      .filter((item) => item.length > 0)
      .join("\n")
    const fallback = typeof data.content === "string" ? data.content : ""

    if (role !== "assistant") {
      const content = text || fallback
      if (content.length > 0) messages.push({ role, content })
      continue
    }

    const calls: Call[] = []
    for (const [index, part] of list.entries()) {
      if (part.type !== "tool") continue
      const name = typeof part.tool === "string" ? part.tool : ""
      if (name.length === 0) continue
      const callID = typeof part.callID === "string" && part.callID.length > 0 ? part.callID : `call_${row.id}_${index}`
      calls.push({
        id: callID,
        type: "function",
        function: { name, arguments: JSON.stringify(part.state?.input ?? {}) },
      })
    }

    const content = text || fallback
    if (content.length > 0 || calls.length > 0) {
      messages.push({
        role: "assistant",
        content: content.length > 0 ? content : null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      })
    }

    for (const [index, part] of list.entries()) {
      if (part.type !== "tool") continue
      const name = typeof part.tool === "string" ? part.tool : ""
      if (name.length === 0) continue
      const callID =
        typeof part.callID === "string" && part.callID.length > 0 ? part.callID : `call_${row.id}_${index}`
      messages.push({ role: "tool", content: legacyToolOutput(part), tool_call_id: callID })
    }
  }

  return messages
}

function loadLegacyHistory(id: string): LoadedHistory | null {
  const db = openLegacyDb()
  if (!db) return null
  try {
    const row = db
      .query(
        `SELECT id, COALESCE(directory, '') AS cwd, time_created AS createdAt, time_updated AS updatedAt
           FROM session WHERE id = ?`,
      )
      .get(id) as { id: string; cwd: string; createdAt: number; updatedAt: number } | null
    if (!row) return null
    return {
      id: row.id,
      status: "closed",
      cwd: row.cwd,
      messages: legacyMessages(db, id),
      kind: "session",
      parentId: null,
      source: "legacy",
    }
  } catch {
    return null
  } finally {
    db.close()
  }
}

/** next/ DB를 먼저 보고, 없으면 기존 croakcode DB에서 읽는다. `run` 이력도 포함한다. */
export function loadHistory(id: string): LoadedHistory | null {
  return loadNextHistory(id) ?? loadLegacyHistory(id)
}

export function latestHistory(): LoadedHistory | null {
  const newest = listHistory(1)[0]
  return newest ? loadHistory(newest.id) : null
}

/**
 * 기존 croakcode DB의 세션을 next/ DB로 가져온다.
 * 같은 id가 이미 next/에 있으면 그대로 쓴다. 원본 DB는 건드리지 않는다.
 */
export function importLegacyHistory(id: string, cwd?: string): LoadedHistory | null {
  const existing = loadNextHistory(id)
  if (existing) return existing
  const legacy = loadLegacyHistory(id)
  if (!legacy) return null
  const db = openDb()
  try {
    const now = Date.now()
    db.transaction(() => {
      db.query(
        "INSERT OR IGNORE INTO sessions (id, status, error, kind, cwd, created_at, updated_at, parent_id) VALUES (?, 'closed', NULL, 'session', ?, ?, ?, NULL)",
      ).run(legacy.id, cwd ?? legacy.cwd, now, now)
      const existing = db.query("SELECT 1 AS found FROM messages WHERE session_id = ? LIMIT 1").get(id)
      if (existing) return
      const insert = db.query("INSERT INTO messages (session_id, seq, body) VALUES (?, ?, ?)")
      for (const [seq, message] of legacy.messages.entries()) insert.run(id, seq, JSON.stringify(message))
    })()
  } finally {
    db.close()
  }
  return loadNextHistory(id)
}

/**
 * 세션을 새 id로 복제한다(포크). 원본 세션과 메시지는 변경하지 않는다.
 * 기존 croakcode DB의 세션도 복제할 수 있다.
 */
export function forkHistory(id: string, cwd?: string): LoadedHistory {
  const source = loadHistory(id)
  if (!source) throw new Error("history_not_found")
  const db = openDb()
  const forkedId = `ses_${randomUUID()}`
  const now = Date.now()
  const targetCwd = cwd ?? source.cwd
  try {
    db.transaction(() => {
      db.query(
        "INSERT INTO sessions (id, status, error, kind, cwd, created_at, updated_at, parent_id) VALUES (?, 'running', NULL, 'session', ?, ?, ?, ?)",
      ).run(forkedId, targetCwd, now, now, source.id)
      const insert = db.query("INSERT INTO messages (session_id, seq, body) VALUES (?, ?, ?)")
      for (const [seq, message] of source.messages.entries()) insert.run(forkedId, seq, JSON.stringify(message))
    })()
  } finally {
    db.close()
  }
  return {
    id: forkedId,
    status: "running",
    cwd: targetCwd,
    messages: source.messages,
    kind: "session",
    parentId: source.id,
    source: "next",
  }
}
