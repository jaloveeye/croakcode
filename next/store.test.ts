import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { createHistoryStore, createStore, latestHistory, listHistory, loadHistory, openDb } from "./store"
import type { Message } from "./chat"

let root = ""
let prev: string | undefined

const msg = (role: string, content: string): Message => ({ role, content }) as Message

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "croak-store-"))
  prev = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = root
})

afterEach(() => {
  if (prev === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = prev
  rmSync(root, { recursive: true, force: true })
})

describe("history store", () => {
  test("대화 이력을 저장하고 다시 불러온다", () => {
    const store = createHistoryStore(root)
    const id = store.id
    store.persist(msg("user", "안녕"))
    store.persist(msg("assistant", "반가워"))
    store.setStatus("closed")
    store.close()

    const loaded = loadHistory(id)
    expect(loaded).not.toBeNull()
    expect(loaded?.status).toBe("closed")
    expect(loaded?.cwd).toBe(root)
    expect(loaded?.messages.map((m) => m.content)).toEqual(["안녕", "반가워"])

    const rows = listHistory()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(id)
    expect(rows[0]?.messages).toBe(2)
  })

  test("run 저장소는 대화 이력 목록에 나오지 않는다", () => {
    const store = createStore()
    store.persist(msg("user", "run"))
    store.setStatus("completed")
    store.close()

    expect(listHistory()).toHaveLength(0)
    expect(loadHistory(store.sessionId)).toBeNull()
  })

  test("latestHistory 는 가장 최근 세션을 돌려준다", () => {
    const first = createHistoryStore(root)
    first.persist(msg("user", "첫째"))
    first.setStatus("closed")
    first.close()
    const second = createHistoryStore(root)
    second.persist(msg("user", "둘째"))
    second.setStatus("closed")
    second.close()

    expect(listHistory().map((r) => r.id)).toEqual([second.id, first.id])
    expect(latestHistory()?.id).toBe(second.id)
    expect(latestHistory()?.messages[0]?.content).toBe("둘째")
  })

  test("기존 id 로 이어 쓰면 seq 와 메시지가 보존된다", () => {
    const first = createHistoryStore(root)
    const id = first.id
    first.persist(msg("user", "하나"))
    first.close()

    const resumed = createHistoryStore(root, id)
    expect(resumed.id).toBe(id)
    resumed.persist(msg("assistant", "둘"))
    resumed.setStatus("closed")
    resumed.close()

    expect(loadHistory(id)?.messages.map((m) => m.content)).toEqual(["하나", "둘"])
  })

  test("없는 id 로 재개하면 거부한다", () => {
    expect(() => createHistoryStore(root, "ses_missing")).toThrow("history_not_found")
  })

  test("구버전 DB 는 컬럼을 추가해 마이그레이션한다", () => {
    const dir = join(root, "croakcode-next")
    mkdirSync(dir, { recursive: true })
    const legacy = new Database(join(dir, "sessions.db"), { create: true })
    legacy.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL, error TEXT)")
    legacy.exec("INSERT INTO sessions (id, status, error) VALUES ('legacy', 'completed', NULL)")
    legacy.close()

    const db = openDb()
    try {
      const cols = (db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name)
      expect(cols).toContain("kind")
      expect(cols).toContain("cwd")
      expect(cols).toContain("created_at")
      expect(cols).toContain("updated_at")
      const row = db.query("SELECT kind FROM sessions WHERE id = 'legacy'").get() as { kind: string }
      expect(row.kind).toBe("run")
    } finally {
      db.close()
    }
  })
})
