import { readFileSync } from "fs"
import { open, stat } from "fs/promises"
import { fileURLToPath } from "url"

/**
 * Turns text that a terminal pasted after a file drag-and-drop into local paths.
 *
 * Windows Terminal pastes Windows paths (`C:\Users\me\a.png`, `\\wsl.localhost\Ubuntu\home\me`)
 * even when the shell runs inside WSL, and quotes paths that contain spaces.
 */

export type DropEnv = {
  platform: NodeJS.Platform
  /** WSL distro name (`WSL_DISTRO_NAME`); undefined outside WSL. */
  wslDistro?: string
  /** WSL automount root, `/mnt` unless /etc/wsl.conf changes it. */
  mountRoot: string
}

/** Pastes longer than this are never treated as dropped files. */
const MAX_DROP_TEXT = 8192
/** At most this many files are accepted from one paste. */
export const MAX_DROP_FILES = 32
/** Bytes sniffed to decide whether a file is text. */
const SNIFF_BYTES = 8192

const ATTACHABLE_EXT = /\.(?:png|jpe?g|gif|webp|bmp|svg|pdf)$/i
const DRIVE_PATH = /^([a-zA-Z]):(?:[\\/](.*))?$/s
const WSL_UNC = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(?:\\(.*))?$/is

export function detectEnv(): DropEnv {
  const wslDistro = process.env.WSL_DISTRO_NAME || undefined
  return { platform: process.platform, wslDistro, mountRoot: wslDistro ? readMountRoot() : "/mnt" }
}

function readMountRoot(): string {
  try {
    return parseMountRoot(readFileSync("/etc/wsl.conf", "utf8"))
  } catch {
    return "/mnt"
  }
}

/** Reads `[automount] root = ...` from wsl.conf contents. */
export function parseMountRoot(conf: string): string {
  let section = ""
  for (const raw of conf.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, "").trim()
    const header = line.match(/^\[(.+)\]$/)
    if (header) {
      section = header[1].trim().toLowerCase()
      continue
    }
    const kv = line.match(/^root\s*=\s*(.+)$/i)
    if (section === "automount" && kv) {
      const root = kv[1].trim().replace(/^["']|["']$/g, "").replace(/\/+$/, "")
      if (root.startsWith("/")) return root || "/"
    }
  }
  return "/mnt"
}

/** Converts one pasted path token to a local path. */
export function toLocalPath(raw: string, env: DropEnv): string {
  if (raw.startsWith("file://")) {
    try {
      return fileURLToPath(raw)
    } catch {
      return raw
    }
  }
  if (env.platform === "win32") return raw
  if (env.wslDistro) {
    const drive = raw.match(DRIVE_PATH)
    if (drive) {
      const rest = (drive[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "")
      return `${env.mountRoot.replace(/\/+$/, "")}/${drive[1].toLowerCase()}${rest ? "/" + rest : ""}`
    }
    const unc = raw.match(WSL_UNC)
    if (unc) {
      // Another distro's files are not reachable from this one; leave the text alone.
      if (unc[1].toLowerCase() !== env.wslDistro.toLowerCase()) return raw
      return "/" + (unc[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "")
    }
  }
  // POSIX terminals escape spaces and shell characters with a backslash.
  return raw.replace(/\\(.)/g, "$1")
}

/**
 * Splits pasted text into path tokens. Quoted tokens keep their spaces, and a
 * backslash followed by whitespace keeps that whitespace. Returns undefined on
 * an unterminated quote.
 */
export function tokenize(text: string): string[] | undefined {
  const tokens: string[] = []
  let i = 0
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++
    if (i >= text.length) break
    const quote = text[i]
    if (quote === '"' || quote === "'") {
      const end = text.indexOf(quote, i + 1)
      if (end === -1) return undefined
      tokens.push(text.slice(i + 1, end))
      i = end + 1
      continue
    }
    let token = ""
    while (i < text.length && !/\s/.test(text[i])) {
      if (text[i] === "\\" && i + 1 < text.length && /\s/.test(text[i + 1])) {
        token += text[i] + text[i + 1]
        i += 2
        continue
      }
      token += text[i]
      i++
    }
    tokens.push(token)
  }
  return tokens
}

function looksLikePath(token: string): boolean {
  return /^(?:\/|~\/|\.\.?\/|file:\/\/|[a-zA-Z]:[\\/]|\\\\)/.test(token)
}

function expandHome(p: string): string {
  const home = process.env.HOME
  return home && p.startsWith("~/") ? home + p.slice(1) : p
}

/**
 * Candidate path groups for a paste, most likely first. The whole paste as one
 * path comes first, so an unquoted path with spaces still works. A group of
 * several paths is offered only when every token looks like a path.
 */
export function candidates(text: string, env: DropEnv): string[][] {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > MAX_DROP_TEXT) return []
  if (/^https?:\/\//.test(trimmed)) return []
  const groups: string[][] = []
  const whole = trimmed.replace(/^['"]+|['"]+$/g, "")
  // A bare word such as `README.md` is ordinary text unless it names an image or PDF,
  // which upstream already attached when pasted as a relative path.
  if (!/[\r\n]/.test(whole) && (looksLikePath(whole) || ATTACHABLE_EXT.test(whole))) {
    groups.push([expandHome(toLocalPath(whole, env))])
  }
  const tokens = tokenize(trimmed)
  if (tokens && tokens.length > 1 && tokens.length <= MAX_DROP_FILES && tokens.every(looksLikePath)) {
    groups.push(tokens.map((t) => expandHome(toLocalPath(t, env))))
  }
  return groups
}

export type DroppedFile = { path: string; kind: "file" | "directory" }

/** Returns the first candidate group whose paths all exist, or undefined. */
export async function resolve(text: string, env: DropEnv = detectEnv()): Promise<DroppedFile[] | undefined> {
  for (const group of candidates(text, env)) {
    const found = await Promise.all(
      group.map(async (p): Promise<DroppedFile | undefined> => {
        const info = await stat(p).catch(() => undefined)
        if (info?.isDirectory()) return { path: p, kind: "directory" }
        if (info?.isFile()) return { path: p, kind: "file" }
        return undefined
      }),
    )
    if (found.every((f): f is DroppedFile => f !== undefined)) return found
  }
  return undefined
}

/** True when the first bytes of a file contain no NUL byte and decode as UTF-8. */
export async function isTextFile(p: string): Promise<boolean> {
  const handle = await open(p, "r").catch(() => undefined)
  if (!handle) return false
  try {
    const buf = Buffer.alloc(SNIFF_BYTES)
    const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0)
    const head = buf.subarray(0, bytesRead)
    if (head.includes(0)) return false
    try {
      // A multi-byte character cut at the sniff boundary is not an error.
      new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: bytesRead === SNIFF_BYTES })
      return true
    } catch {
      return false
    }
  } finally {
    await handle.close()
  }
}

/** Quotes a path for plain-text insertion when it contains whitespace. */
export function quoteForText(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p
}

export * as DroppedPath from "./dropped-path"
