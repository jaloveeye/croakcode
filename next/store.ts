import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { dataDir } from "./paths"
import type { Message } from "./chat"

const BUSY_TIMEOUT_MS = 5_000

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
  return db
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
  db.query("INSERT INTO sessions (id, status, error, kind, cwd, created_at, updated_at) VALUES (?, 'running', NULL, 'run', ?, ?, ?)").run(
    sessionId,
    process.cwd(),
    now,
    now,
  )
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
    const max = db.query("SELECT COALESCE(MAX(seq), -1) AS m FROM messages WHERE session_id = ?").get(sessionId) as { m: number }
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

export type HistoryMeta = {
  id: string
  status: string
  cwd: string
  createdAt: number
  updatedAt: number
  messages: number
}

export type LoadedHistory = {
  id: string
  status: string
  cwd: string
  messages: Message[]
}

export function listHistory(limit = 20): HistoryMeta[] {
  const db = openDb()
  try {
    return db
      .query(
        `SELECT s.id, s.status, COALESCE(s.cwd, '') AS cwd, s.created_at AS createdAt, s.updated_at AS updatedAt,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messages
           FROM sessions s
          WHERE s.kind = 'session'
          ORDER BY s.updated_at DESC, s.rowid DESC
          LIMIT ?`,
      )
      .all(limit) as HistoryMeta[]
  } finally {
    db.close()
  }
}

export function loadHistory(id: string): LoadedHistory | null {
  const db = openDb()
  try {
    const row = db
      .query("SELECT id, status, COALESCE(cwd, '') AS cwd FROM sessions WHERE id = ? AND kind = 'session'")
      .get(id) as { id: string; status: string; cwd: string } | null
    if (!row) return null
    const rows = db.query("SELECT body FROM messages WHERE session_id = ? ORDER BY seq").all(id) as Array<{ body: string }>
    const messages: Message[] = []
    for (const item of rows) {
      try {
        messages.push(JSON.parse(item.body) as Message)
      } catch {
        // 손상된 메시지는 건너뛴다
      }
    }
    return { ...row, messages }
  } finally {
    db.close()
  }
}

export function latestHistory(): LoadedHistory | null {
  const newest = listHistory(1)[0]
  return newest ? loadHistory(newest.id) : null
}
