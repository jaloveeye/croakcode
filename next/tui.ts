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
    viewer: null as Viewer | null,
    session: null as Session | null,
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
    const left = `${BOLD}${truncate(leftRaw, Math.max(8, width - displayWidth(rightRaw)))}${RESET}`
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
      const col = Math.min(width, displayWidth("> ") + displayWidth(state.input) + 1)
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
    schedule()
    if (!line.trim() || !state.session) return
    void state.session.handleLine(line)
  }

  const onData = (chunk: Buffer) => {
    if (state.closed) return
    const text = chunk.toString("utf8")
    if (state.viewer) {
      handleViewerKey(text)
      return
    }
    for (const ch of text) {
      if (ch === "\r" || ch === "\n") {
        submit()
      } else if (ch === "\x7f" || ch === "\b") {
        state.input = state.input.slice(0, -1)
      } else if (ch === "\x03") {
        // Ctrl+C
        void state.session?.interrupt()
        close()
        return
      } else if (ch === "\x04") {
        // Ctrl+D: 입력 비었으면 종료
        if (state.input.length === 0) {
          void state.session?.interrupt()
          close()
          return
        }
      } else if (ch >= " " || ch === "\t") {
        state.input += ch
      }
    }
    schedule()
  }

  const handleViewerKey = (text: string) => {
    const v = state.viewer
    if (!v) return
    for (const ch of text) {
      if (ch === "q" || ch === "\x1b" || ch === "\x03") {
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

  const close = () => {
    if (state.closed) return
    state.closed = true
    if (frame) clearTimeout(frame)
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
