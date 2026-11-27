import type { Session } from "./session"

const ESC = "\x1b["
const ALT_ON = `${ESC}?1049h`
const ALT_OFF = `${ESC}?1049l`
const CURSOR_HIDE = `${ESC}?25l`
const CURSOR_SHOW = `${ESC}?25h`
const CLEAR = `${ESC}2J`
const CLEAR_LINE = `${ESC}2K`
const HOME = `${ESC}H`
const REVERSE = `${ESC}7m`
const RESET = `${ESC}0m`
const DIM = `${ESC}2m`
const BOLD = `${ESC}1m`
const MAX_LOG = 5000

export type Status = { name: string; inbound: string; activity: "idle" | "busy"; peers: number }

type Viewer = { title: string; lines: string[]; scroll: number }

export type Tui = {
  /** 출력 라인을 로그에 추가하고 다시 그린다. */
  writeLine(line: string): void
  setStatus(patch: Partial<Status>): void
  /** 주기적으로 상태를 갱신할 공급자를 등록한다(피어 수 등). */
  setStatusProvider(fn: () => Partial<Status>): void
  /** 전체화면 뷰어를 연다. */
  openViewer(title: string, text: string): void
  /** 입력 처리를 시작한다(세션 준비 후). */
  start(session: Session): void
  /** 화면을 원복하고 종료한다. */
  close(): void
}

export function createTui(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, initial: Status): Tui {
  const state = {
    width: stdout.columns || 80,
    height: stdout.rows || 24,
    status: { ...initial } as Status,
    log: [] as string[],
    input: "",
    cursor: 0,
    history: [] as string[],
    historyIdx: -1,
    viewer: null as Viewer | null,
    session: null as Session | null,
    statusProvider: null as (() => Partial<Status>) | null,
    closed: false,
  }

  const write = (s: string) => stdout.write(s)

  const draw = () => {
    if (state.closed) return
    const { width, height } = state
    state.width = width
    state.height = height
    const rows: string[] = []

    const s = state.status
    const leftRaw = ` ${s.name}`
    const rightRaw = `${s.activity === "busy" ? "● busy" : "○ idle"} · ${s.peers} peers · ${s.inbound} `
    const gap = Math.max(0, width - displayWidth(leftRaw) - displayWidth(rightRaw))
    rows.push(`${REVERSE}${truncate(leftRaw, width)}${" ".repeat(gap)}${rightRaw}${RESET}`)

    if (state.viewer) {
      const v = state.viewer
      const bodyHeight = height - 3
      v.scroll = clamp(v.scroll, 0, Math.max(0, v.lines.length - bodyHeight))
      rows.push(`${BOLD}${truncate(` ${v.title}`, width)}${RESET}`)
      for (let i = 0; i < bodyHeight; i++) {
        rows.push(truncate(v.lines[v.scroll + i] ?? "", width))
      }
      rows.push(`${DIM}${truncate(" j/k 스크롤 · PgUp/PgDn · q/esc 닫기", width)}${RESET}`)
    } else {
      const bodyHeight = height - 3
      const start = Math.max(0, state.log.length - bodyHeight)
      const visible = state.log.slice(start)
      for (let i = 0; i < bodyHeight; i++) {
        rows.push(truncate(visible[i] ?? "", width))
      }
      rows.push(truncate(`> ${state.input}`, width))
      rows.push(`${DIM}${truncate(" Enter 전송 · /help 명령 · Ctrl+C 종료", width)}${RESET}`)
    }

    while (rows.length < height) rows.push("")
    const frame = rows.slice(0, height).map((row) => `${CLEAR_LINE}${row}`).join("\r\n")
    write(`${HOME}${CLEAR}${frame}`)
    if (!state.viewer) {
      const inputRow = height - 1
      const before = state.input.slice(0, state.cursor)
      const col = Math.min(width, displayWidth("> ") + displayWidth(before) + 1)
      write(`${ESC}${inputRow};${col}H`)
    } else {
      write(`${ESC}${height};1H`)
    }
  }

  let frame: ReturnType<typeof setTimeout> | null = null
  const schedule = () => {
    if (frame) return
    frame = setTimeout(() => {
      frame = null
      draw()
    }, 16)
  }

  const submit = () => {
    const line = state.input
    state.input = ""
    state.cursor = 0
    state.historyIdx = -1
    if (line.trim()) {
      // 직전 항목과 같으면 중복 저장하지 않는다(히스토리 재호출 대응).
      if (state.history[state.history.length - 1] !== line) {
        state.history.push(line)
        if (state.history.length > 200) state.history.shift()
      }
    }
    schedule()
    if (!line.trim() || !state.session) return
    void state.session.handleLine(line)
  }

  const setInput = (value: string, cursor: number) => {
    state.input = value
    state.cursor = clamp(cursor, 0, value.length)
  }

  const insert = (text: string) => {
    const before = state.input.slice(0, state.cursor)
    const after = state.input.slice(state.cursor)
    setInput(before + text + after, state.cursor + text.length)
  }

  const backspace = () => {
    if (state.cursor === 0) return
    setInput(state.input.slice(0, state.cursor - 1) + state.input.slice(state.cursor), state.cursor - 1)
  }

  const deleteForward = () => {
    if (state.cursor >= state.input.length) return
    setInput(state.input.slice(0, state.cursor) + state.input.slice(state.cursor + 1), state.cursor)
  }

  const historyPrev = () => {
    if (state.history.length === 0) return
    if (state.historyIdx === -1) state.historyIdx = state.history.length
    state.historyIdx = Math.max(0, state.historyIdx - 1)
    const value = state.history[state.historyIdx] ?? ""
    setInput(value, value.length)
  }

  const historyNext = () => {
    if (state.historyIdx === -1) return
    state.historyIdx = Math.min(state.history.length, state.historyIdx + 1)
    const value = state.historyIdx >= state.history.length ? "" : (state.history[state.historyIdx] ?? "")
    setInput(value, value.length)
  }

  // 입력 편집용 키 처리. 이스케이프 시퀀스는 완성된 단위로 전달된다.
  const handleEditKey = (key: string): boolean => {
    switch (key) {
      case "\r":
      case "\n":
        submit()
        return true
      case "\x7f":
      case "\b":
        backspace()
        return true
      case "\x03": // Ctrl+C
        void state.session?.interrupt()
        close()
        return true
      case "\x04": // Ctrl+D
        if (state.input.length === 0) {
          void state.session?.interrupt()
          close()
        } else {
          deleteForward()
        }
        return true
      case "\x01": // Ctrl+A
        setInput(state.input, 0)
        return true
      case "\x05": // Ctrl+E
        setInput(state.input, state.input.length)
        return true
      case "\x0b": // Ctrl+K: 줄 끝까지 삭제
        setInput(state.input.slice(0, state.cursor), state.cursor)
        return true
      case "\x15": // Ctrl+U: 줄 시작까지 삭제
        setInput(state.input.slice(state.cursor), 0)
        return true
      case "\x1b[D": // left
        setInput(state.input, state.cursor - 1)
        return true
      case "\x1b[C": // right
        setInput(state.input, state.cursor + 1)
        return true
      case "\x1b[H":
      case "\x1b[1~":
      case "\x1bOH":
        setInput(state.input, 0)
        return true
      case "\x1b[F":
      case "\x1b[4~":
      case "\x1bOF":
        setInput(state.input, state.input.length)
        return true
      case "\x1b[3~": // delete
        deleteForward()
        return true
      case "\x1b[A": // up
        historyPrev()
        return true
      case "\x1b[B": // down
        historyNext()
        return true
      default:
        return false
    }
  }

  // 부분 이스케이프 시퀀스 버퍼
  let pending = ""
  const ESC_RE = /\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])/

  const onData = (chunk: Buffer) => {
    if (state.closed) return
    if (state.viewer) {
      handleViewerKey(chunk.toString("utf8"))
      return
    }
    let text = pending + chunk.toString("utf8")
    pending = ""

    while (text.length > 0) {
      const m = ESC_RE.exec(text)
      if (m && m.index === 0) {
        handleEditKey(m[0])
        text = text.slice(m[0].length)
        continue
      }
      // 시작이 ESC인데 아직 완성되지 않은 시퀀스일 수 있다.
      if (text[0] === "\x1b") {
        if (text.length === 1) {
          pending = text // 다음 청크를 기다린다
          break
        }
        // 알 수 없는 이스케이프는 ESC 키로 간주하고 버린다.
        handleEditKey("\x1b")
        text = text.slice(1)
        continue
      }
      const ch = text[0] as string
      text = text.slice(1)
      if (handleEditKey(ch)) continue
      if (ch >= " " || ch === "\t") insert(ch)
    }
    schedule()
  }

  const handleViewerKey = (text: string) => {
    const v = state.viewer
    if (!v) return
    // 이스케이프 시퀀스(화살표/PageUp 등)를 먼저 처리한다.
    const seq = ESC_RE.exec(text)
    if (seq && seq.index === 0) {
      const s = seq[0]
      if (s === "\x1b[A" || s === "\x1b[5~") v.scroll -= state.height - 3
      else if (s === "\x1b[B" || s === "\x1b[6~") v.scroll += state.height - 3
      else if (s === "\x1b[Z") v.scroll -= 1
      schedule()
      return
    }
    for (const ch of text) {
      if (ch === "q" || ch === "\x03" || ch === "\x1b") {
        state.viewer = null
        break
      } else if (ch === "j") {
        v.scroll += 1
      } else if (ch === "k") {
        v.scroll -= 1
      } else if (ch === " ") {
        v.scroll += state.height - 3
      }
    }
    schedule()
  }

  const onResize = () => {
    state.width = stdout.columns || 80
    state.height = stdout.rows || 24
    schedule()
  }

  let refresh: ReturnType<typeof setInterval> | null = null
  const close = () => {
    if (state.closed) return
    state.closed = true
    if (frame) clearTimeout(frame)
    if (refresh) clearInterval(refresh)
    stdin.off("data", onData)
    stdout.off("resize", onResize)
    if (stdin.isTTY) stdin.setRawMode(false)
    stdin.pause()
    write(`${CURSOR_SHOW}${ALT_OFF}`)
  }

  return {
    writeLine(line: string) {
      state.log.push(line)
      if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG)
      schedule()
    },
    setStatus(patch: Partial<Status>) {
      Object.assign(state.status, patch)
      schedule()
    },
    setStatusProvider(fn: () => Partial<Status>) {
      state.statusProvider = fn
    },
    openViewer(title: string, text: string) {
      state.viewer = { title, lines: text.split("\n"), scroll: 0 }
      schedule()
    },
    start(session: Session) {
      state.session = session
      write(`${ALT_ON}${CURSOR_HIDE}`)
      if (stdin.isTTY) stdin.setRawMode(true)
      stdin.on("data", onData)
      stdout.on("resize", onResize)
      stdin.resume()
      // 피어 수 등 외부 상태를 주기적으로 새로고침한다(로그는 건드리지 않음).
      refresh = setInterval(() => {
        if (state.closed || !state.statusProvider) return
        Object.assign(state.status, state.statusProvider())
        schedule()
      }, 2000)
      if (refresh.unref) refresh.unref()
      draw()
    },
    close,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  if (code === 0) return 0
  if (code >= 0x0300 && code <= 0x036f) return 0
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  ) {
    return 2
  }
  return 1
}

function displayWidth(text: string): number {
  let w = 0
  for (const ch of text) w += charWidth(ch)
  return w
}

function truncate(text: string, width: number): string {
  let out = ""
  let w = 0
  for (const ch of text) {
    const cw = charWidth(ch)
    if (w + cw > width) break
    out += ch
    w += cw
  }
  return out
}
