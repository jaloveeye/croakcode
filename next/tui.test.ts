import { afterEach, describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { createTui } from "./tui"
import type { Session } from "./session"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type FakeSession = Session & { lines: string[]; interrupts: number }

function fakeSession(): FakeSession {
  const lines: string[] = []
  const s = {
    lines,
    interrupts: 0,
    handleLine(line: string) {
      lines.push(line)
      return Promise.resolve()
    },
    interrupt() {
      s.interrupts += 1
      return Promise.resolve()
    },
  } as unknown as FakeSession
  return s
}

type Harness = {
  tui: ReturnType<typeof createTui>
  session: FakeSession
  send: (data: string) => void
  screen: () => string
  dispose: () => void
}

function harness(): Harness {
  const stdin = new PassThrough()
  const chunks: string[] = []
  const out = new PassThrough()
  ;(out as unknown as { columns: number }).columns = 40
  ;(out as unknown as { rows: number }).rows = 10
  out.on("data", (b: Buffer) => chunks.push(b.toString("utf8")))
  const tui = createTui(
    stdin as unknown as NodeJS.ReadStream,
    out as unknown as NodeJS.WriteStream,
    { name: "t1", inbound: "hold", activity: "idle", peers: 1 },
  )
  const session = fakeSession()
  tui.start(session)
  return {
    tui,
    session,
    send: (data: string) => stdin.write(Buffer.from(data, "utf8")),
    // 전체 출력을 이어붙여 렌더 상태를 검사한다(ANSI 포함).
    screen: () => chunks.join(""),
    dispose: () => {
      tui.close()
      stdin.end()
    },
  }
}

let open: Harness | null = null
afterEach(() => {
  open?.dispose()
  open = null
})

describe("tui 입력 편집", () => {
  test("Enter 로 제출하고 입력줄이 비워진다", async () => {
    open = harness()
    open.send("hello\r")
    await sleep(10)
    expect(open.session.lines).toEqual(["hello"])
  })

  test("빈 줄은 제출하지 않는다", async () => {
    open = harness()
    open.send("\r")
    await sleep(10)
    expect(open.session.lines).toEqual([])
  })

  test("왼쪽 화살표 커서 이동 후 삽입", async () => {
    open = harness()
    open.send("ac")
    open.send("\x1b[D") // left
    open.send("b")
    open.send("\r")
    await sleep(10)
    expect(open.session.lines).toEqual(["abc"])
  })

  test("백스페이스는 커서 앞 문자를 지운다", async () => {
    open = harness()
    open.send("abc")
    open.send("\x1b[D\x1b[D") // 커서를 'b' 앞으로 (index 1)
    open.send("\x7f") // 백스페이스로 'a' 삭제
    open.send("\r")
    await sleep(10)
    expect(open.session.lines).toEqual(["bc"])
  })

  test("Delete(\\x1b[3~)는 커서 뒤 문자를 지운다", async () => {
    open = harness()
    open.send("abc")
    open.send("\x1b[D\x1b[D") // 커서 b 앞
    open.send("\x1b[3~") // 'b' 삭제
    open.send("\r")
    await sleep(10)
    expect(open.session.lines).toEqual(["ac"])
  })

  test("Home/End 로 이동", async () => {
    open = harness()
    open.send("bc")
    open.send("\x1b[H") // home
    open.send("a")
    open.send("\x1b[F") // end
    open.send("d")
    open.send("\r")
    await sleep(10)
    expect(open.session.lines).toEqual(["abcd"])
  })

  test("위/아래 화살표로 히스토리 탐색", async () => {
    open = harness()
    open.send("first\r")
    await sleep(10)
    open.send("second\r")
    await sleep(10)
    open.send("\x1b[A") // up -> second
    open.send("\r")
    await sleep(10)
    open.send("\x1b[A\x1b[A") // up up -> first
    open.send("\r")
    await sleep(10)
    expect(open.session.lines).toEqual(["first", "second", "second", "first"])
  })

  test("Ctrl+U 로 줄 전체 삭제", async () => {
    open = harness()
    open.send("garbage")
    open.send("\x15")
    open.send("\r")
    await sleep(10)
    expect(open.session.lines).toEqual([])
  })

  test("Ctrl+C 는 interrupt 후 화면을 닫는다", async () => {
    open = harness()
    open.send("\x03")
    await sleep(10)
    expect(open.session.interrupts).toBe(1)
  })

  test("부분 이스케이프 시퀀스가 청크로 나뉘어도 처리된다", async () => {
    open = harness()
    open.send("ac")
    open.send("\x1b") // 시퀀스 시작만 도착
    await sleep(5)
    open.send("[D") // 나머지 도착 -> left
    open.send("b\r")
    await sleep(10)
    expect(open.session.lines).toEqual(["abc"])
  })
})

describe("tui 상태/뷰어", () => {
  test("setStatus 가 상태줄에 반영된다", async () => {
    open = harness()
    open.tui.setStatus({ activity: "busy", peers: 3, inbound: "accept" })
    await sleep(30)
    const screen = open.screen()
    expect(screen).toContain("busy")
    expect(screen).toContain("3 peers")
    expect(screen).toContain("accept")
  })

  test("openViewer 로 전체화면 뷰어를 열고 q 로 닫는다", async () => {
    open = harness()
    open.tui.openViewer("보낸이: a1", "첫줄\n둘째줄")
    await sleep(30)
    let screen = open.screen()
    expect(screen).toContain("첫줄")
    expect(screen).toContain("둘째줄")
    open.send("q")
    await sleep(30)
    // 뷰어를 닫으면 입력줄 프롬프트가 다시 보인다.
    screen = open.screen()
    expect(screen.lastIndexOf(">")).toBeGreaterThan(-1)
  })
})

describe("tui 색상", () => {
  const prev = { FORCE_COLOR: process.env.FORCE_COLOR, NO_COLOR: process.env.NO_COLOR }
  afterEach(() => {
    if (prev.FORCE_COLOR === undefined) delete process.env.FORCE_COLOR
    else process.env.FORCE_COLOR = prev.FORCE_COLOR
    if (prev.NO_COLOR === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = prev.NO_COLOR
  })

  test("FORCE_COLOR 면 상태줄에 배경색 코드가 들어간다", async () => {
    process.env.FORCE_COLOR = "1"
    delete process.env.NO_COLOR
    open = harness()
    await sleep(30)
    // 상태줄 배경(48;5;24)
    expect(open.screen()).toContain("\x1b[48;5;24m")
  })

  test("NO_COLOR 면 색상 코드가 없다", async () => {
    process.env.FORCE_COLOR = "1"
    process.env.NO_COLOR = "1"
    open = harness()
    await sleep(30)
    const screen = open.screen()
    expect(screen).not.toContain("\x1b[48;5;24m")
    expect(screen).not.toContain("\x1b[38;5;")
  })
})
