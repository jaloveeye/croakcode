import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startSession, type Session } from "./session"

let root = ""
const opened: Session[] = []

function output(sink: string[]) {
  return {
    write(chunk: string | Uint8Array): boolean {
      sink.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    },
  } as unknown as NodeJS.WritableStream
}

async function open(name: string, sink: string[]): Promise<Session> {
  const input = new PassThrough()
  const session = await startSession({
    name,
    input: input as unknown as NodeJS.ReadableStream,
    output: output(sink),
    cwd: root,
  })
  opened.push(session)
  return session
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "croak-session-"))
  process.env.XDG_DATA_HOME = join(root, "data")
  process.env.XDG_RUNTIME_DIR = join(root, "run")
})

afterEach(async () => {
  for (const session of opened.splice(0)) {
    try {
      await session.interrupt()
    } catch {
      // 정리 실패는 무시한다
    }
  }
  rmSync(root, { recursive: true, force: true })
})

describe("session messaging", () => {
  test("hold: 메시지를 보류 큐에 넣고 /held 로 보여준다", async () => {
    const aOut: string[] = []
    const bOut: string[] = []
    const a = await open("alpha", aOut)
    const b = await open("beta", bOut)

    await a.handleLine("/send beta 안녕")
    await sleep(100)

    expect(bOut.join("")).toContain("(보류 1) alpha: 안녕")
    bOut.length = 0
    await b.handleLine("/held")
    expect(bOut.join("")).toContain("[1] alpha: 안녕")
    void a
  })

  test("accept: 받은 즉시 표시한다", async () => {
    const aOut: string[] = []
    const bOut: string[] = []
    const a = await open("alpha", aOut)
    const b = await open("beta", bOut)
    await b.handleLine("/inbound accept")

    await a.handleLine("/send beta 바로표시")
    await sleep(100)

    expect(bOut.join("")).toContain("[alpha] 바로표시")
    void a
  })

  test("refuse: 메시지를 거부하고 보류 큐에 넣지 않는다", async () => {
    const aOut: string[] = []
    const bOut: string[] = []
    const a = await open("alpha", aOut)
    const b = await open("beta", bOut)
    await b.handleLine("/inbound refuse")

    await a.handleLine("/send beta 거절될것")
    await sleep(100)

    expect(bOut.join("")).toContain("(거부됨) alpha: 거절될것")
    bOut.length = 0
    await b.handleLine("/held")
    expect(bOut.join("")).toContain("보류 중인 메시지가 없다")
    void a
  })

  test("/peers 는 자기 자신을 포함해 나열한다", async () => {
    const aOut: string[] = []
    const a = await open("alpha", aOut)
    await open("beta", [])
    aOut.length = 0
    await a.handleLine("/peers")
    const text = aOut.join("")
    expect(text).toContain("alpha (나)")
    expect(text).toContain("beta")
  })

  test("동일 이름 세션은 거부된다", async () => {
    await open("dup", [])
    const input = new PassThrough()
    await expect(
      startSession({ name: "dup", input: input as unknown as NodeJS.ReadableStream, output: output([]), cwd: root }),
    ).rejects.toThrow(/이미 사용 중인 세션 이름/)
  })

  test("보류 큐는 같은 이름 재시작 후에도 남는다", async () => {
    const aOut: string[] = []
    const bOut: string[] = []
    const a = await open("alpha", aOut)
    const b = await open("beta", bOut)
    await a.handleLine("/send beta 남겨둘것")
    await sleep(100)
    await b.interrupt()

    const cOut: string[] = []
    const c = await open("beta", cOut)
    expect(c.transcript().join("")).toContain("보류 중인 메시지 1건")
    cOut.length = 0
    await c.handleLine("/held")
    expect(cOut.join("")).toContain("남겨둘것")
    void a
  })

  test("/rename 은 이름을 바꾸고 이후 그 이름으로 송신된다", async () => {
    const aOut: string[] = []
    const bOut: string[] = []
    const a = await open("alpha", aOut)
    const b = await open("beta", bOut)
    await b.handleLine("/rename gamma")
    await a.handleLine("/send gamma 새이름으로")
    await sleep(100)
    expect(bOut.join("")).toContain("(보류 1) alpha: 새이름으로")
    void a
  })
})
