import { readdirSync } from "node:fs"
import { join } from "node:path"
import { deniedPath, readFileBounded, resolveInside, SafeError } from "./fsafe"

/** 한 번의 탐색 출력 상한(바이트). */
export const MAX_OUTPUT_BYTES = 16 * 1024
export const MAX_LIST_ENTRIES = 200
export const MAX_FIND_RESULTS = 200
export const MAX_GREP_MATCHES = 100
const MAX_SCAN_FILES = 2000
const MAX_DEPTH = 12
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".cache", ".next", "target"])

export type ListResult = { entries: string[]; truncated: boolean }
export type FindResult = { files: string[]; truncated: boolean }
export type GrepHit = { file: string; line: number; text: string }
export type GrepResult = { hits: GrepHit[]; scanned: number; truncated: boolean }

function fail(code: string, message: string): never {
  throw new SafeError(code, message)
}

export function normalizeGlob(glob: string): string {
  const value = (glob ?? "").trim().replace(/\\/g, "/")
  if (!value) fail("glob_invalid", "패턴이 비어 있다")
  if (value.startsWith("/")) fail("glob_invalid", "절대 경로 패턴은 허용되지 않는다")
  if (value.split("/").includes("..")) fail("glob_invalid", "상위 경로 표기는 허용되지 않는다")
  return value.replace(/^\.\//, "")
}

/** `*`(구분자 제외), `**`(임의 경로), `?`(한 글자)를 지원하는 최소 glob. */
export function globToRegExp(glob: string): RegExp {
  let out = "^"
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++
        if (glob[i + 1] === "/") {
          i++
          out += "(?:.*/)?"
        } else {
          out += ".*"
        }
      } else {
        out += "[^/]*"
      }
    } else if (ch === "?") {
      out += "[^/]"
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return new RegExp(`${out}$`)
}

function* walk(cwd: string): Generator<string> {
  let scanned = 0
  const stack: string[] = [""]
  while (stack.length > 0) {
    const relDir = stack.pop() as string
    const absDir = relDir ? join(cwd, relDir) : cwd
    let dirents
    try {
      dirents = readdirSync(absDir, { withFileTypes: true })
    } catch {
      continue
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name))
    for (const d of dirents) {
      if (d.isSymbolicLink()) continue
      const rel = relDir ? `${relDir}/${d.name}` : d.name
      if (deniedPath(rel)) continue
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name) || d.name.startsWith(".")) continue
        if (rel.split("/").length >= MAX_DEPTH) continue
        stack.push(rel)
      } else if (d.isFile()) {
        if (scanned >= MAX_SCAN_FILES) return
        scanned++
        yield rel
      }
    }
  }
}

export function listDir(cwd: string, dir = "."): ListResult {
  const abs = resolveInside(cwd, dir)
  let dirents
  try {
    dirents = readdirSync(abs, { withFileTypes: true })
  } catch {
    fail("list_failed", "디렉터리를 읽을 수 없다")
  }
  const entries = dirents
    .filter((d) => !d.isSymbolicLink() && !deniedPath(d.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
  return { entries: entries.slice(0, MAX_LIST_ENTRIES), truncated: entries.length > MAX_LIST_ENTRIES }
}

export function findFiles(cwd: string, glob: string): FindResult {
  const re = globToRegExp(normalizeGlob(glob))
  const files: string[] = []
  for (const rel of walk(cwd)) {
    if (!re.test(rel)) continue
    files.push(rel)
    if (files.length >= MAX_FIND_RESULTS) return { files, truncated: true }
  }
  return { files, truncated: false }
}

export function grepFiles(cwd: string, pattern: string, include?: string): GrepResult {
  const needle = (pattern ?? "").trim()
  if (!needle) fail("grep_invalid", "검색어가 비어 있다")
  if (needle.includes("\0")) fail("grep_invalid", "NUL 문자는 허용되지 않는다")
  const lower = needle.toLowerCase()
  const includeRe = include && include.trim() ? globToRegExp(normalizeGlob(include)) : null
  const hits: GrepHit[] = []
  let scanned = 0
  for (const rel of walk(cwd)) {
    if (includeRe && !includeRe.test(rel)) continue
    let content: string
    try {
      content = readFileBounded(join(cwd, rel))
    } catch {
      continue
    }
    scanned++
    const lines = content.split("\n")
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(lower)) continue
      hits.push({ file: rel, line: i + 1, text: lines[i] })
      if (hits.length >= MAX_GREP_MATCHES) return { hits, scanned, truncated: true }
    }
  }
  return { hits, scanned, truncated: false }
}

/** 세션 출력용: 바이트 상한까지만 남기고 잘랐는지 알려준다. */
export function clampOutput(text: string, max = MAX_OUTPUT_BYTES): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8")
  if (bytes.length <= max) return { text, truncated: false }
  const sliced = bytes.subarray(0, max).toString("utf8").replace(/\uFFFD+$/, "")
  return { text: sliced, truncated: true }
}
