import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import {
  createHistoryStore,
  createStore,
  forkHistory,
  importLegacyHistory,
  latestHistory,
  listHistory,
  loadHistory,
  openDb,
} from "./store"
import type { Message } from "./chat"

let root = ""
let prev: string | undefined

const msg = (role: string, content: string): Message => ({ role, content }) as Message

/** upstream(croakcode) 형식의 session/message/part DB를 만든다. */
function seedLegacy(base: string, filename = "croakcode.db"): void {
  const dir = join(base, "croakcode")
  mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, filename), { create: true })
  try {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT,
        time_created INTEGER, time_updated INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT
      );
    `)
    db.query("INSERT INTO session (id, project_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)").run(
      "ses_legacy",
      "prj_legacy",
      base,
      "기존 세션",
      1000,
      2000,
    )
    db.query("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
      "msg_user",
      "ses_legacy",
      1000,
      JSON.stringify({ role: "user" }),
    )
    db.query("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)").run(
      "prt_user",
      "msg_user",
      "ses_legacy",
      1000,
      JSON.stringify({ type: "text", text: "안녕" }),
    )
    db.query("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
      "msg_assistant",
      "ses_legacy",
      1001,
      JSON.stringify({ role: "assistant" }),
    )
    db.query("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)").run(
      "prt_text",
      "msg_assistant",
      "ses_legacy",
      1001,
      JSON.stringify({ type: "text", text: "파일을 읽는다" }),
    )
    db.query("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)").run(
      "prt_tool",
      "msg_assistant",
      "ses_legacy",
      1002,
      JSON.stringify({
        type: "tool",
        callID: "call_1",
        tool: "read",
        state: { status: "completed", input: { filePath: "README.md" }, output: "파일 내용" },
      }),
    )
  } finally {
    db.close()
  }
}

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

  test("run 저장소도 이력 목록과 재개 대상에 포함된다", () => {
    const store = createStore()
    store.persist(msg("user", "run"))
    store.setStatus("completed")
    store.close()

    const rows = listHistory()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(store.sessionId)
    expect(rows[0]?.kind).toBe("run")
    expect(loadHistory(store.sessionId)?.messages.map((m) => m.content)).toEqual(["run"])
  })

  test("포크는 새 세션에 메시지를 복제하고 원본을 바꾸지 않는다", () => {
    const first = createHistoryStore(root)
    first.persist(msg("user", "하나"))
    first.persist(msg("assistant", "둘"))
    first.setStatus("closed")
    first.close()

    const forked = forkHistory(first.id)
    expect(forked.id).not.toBe(first.id)
    expect(forked.parentId).toBe(first.id)
    expect(forked.messages.map((m) => m.content)).toEqual(["하나", "둘"])

    const resumed = createHistoryStore(root, forked.id)
    resumed.persist(msg("user", "셋"))
    resumed.setStatus("closed")
    resumed.close()

    expect(loadHistory(first.id)?.messages.map((m) => m.content)).toEqual(["하나", "둘"])
    expect(loadHistory(forked.id)?.messages.map((m) => m.content)).toEqual(["하나", "둘", "셋"])
    expect(loadHistory(forked.id)?.parentId).toBe(first.id)
  })

  test("기존 croakcode DB 세션을 읽고 next DB로 가져온다", () => {
    seedLegacy(root)

    const rows = listHistory()
    expect(rows.some((row) => row.id === "ses_legacy" && row.source === "legacy")).toBe(true)
    const loaded = loadHistory("ses_legacy")
    expect(loaded?.source).toBe("legacy")
    expect(loaded?.cwd).toBe(root)
    expect(loaded?.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"])
    expect(loaded?.messages[0]?.content).toBe("안녕")
    expect(loaded?.messages[1]?.tool_calls?.[0]?.function.name).toBe("read")
    expect(loaded?.messages[1]?.tool_calls?.[0]?.function.arguments).toBe(JSON.stringify({ filePath: "README.md" }))
    expect(loaded?.messages[2]).toMatchObject({ content: "파일 내용", tool_call_id: "call_1" })

    const imported = importLegacyHistory("ses_legacy", root)
    expect(imported?.source).toBe("next")
    expect(imported?.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"])

    const resumed = createHistoryStore(root, "ses_legacy")
    resumed.persist(msg("user", "이어서"))
    resumed.setStatus("closed")
    resumed.close()
    expect(loadHistory("ses_legacy")?.messages.map((m) => m.content).slice(-1)).toEqual(["이어서"])

    const legacy = new Database(join(root, "croakcode", "croakcode.db"), { readonly: true })
    try {
      const count = legacy.query("SELECT COUNT(*) AS n FROM message").get() as { n: number }
      expect(count.n).toBe(2)
    } finally {
      legacy.close()
    }
  })

  test("설치본 DB가 없으면 소스 실행용 croakcode-local.db를 읽는다", () => {
    seedLegacy(root, "croakcode-local.db")
    expect(loadHistory("ses_legacy")?.source).toBe("legacy")
    expect(listHistory().some((row) => row.id === "ses_legacy")).toBe(true)
  })

  test("기존 croakcode DB 세션도 포크할 수 있다", () => {
    seedLegacy(root)
    const forked = forkHistory("ses_legacy", root)
    expect(forked.id).not.toBe("ses_legacy")
    expect(forked.parentId).toBe("ses_legacy")
    expect(loadHistory(forked.id)?.source).toBe("next")
    expect(loadHistory(forked.id)?.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"])
    expect(loadHistory("ses_legacy")?.source).toBe("legacy")
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
