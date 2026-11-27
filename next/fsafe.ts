import { constants as fsConstants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export const MAX_FILE_BYTES = 16 * 1024
export const MAX_WRITE_BYTES = 64 * 1024
const READ_LIMIT = MAX_FILE_BYTES + 1
const WRITE_DENY_DIRS = [".git", ".hg", ".svn"]

const DENY_DIRS = [".ssh", ".aws", ".gnupg", ".config/croak"]
const DENY_FILES = [".env", "*.env", "*.pem", "*.key", "id_rsa*", "id_ed25519*", "id_ecdsa*"]

export class SafeError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new SafeError(code, message)
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  return new RegExp("^" + escaped.replace(/\*/g, ".*") + "$")
}

const FILE_RES = DENY_FILES.map((glob) => [glob, globToRegex(glob)] as const)

export function deniedPath(value: string): string | null {
  const segs = value.trim().replace(/\\/g, "/").split("/").filter(Boolean)
  for (const dir of DENY_DIRS) {
    const parts = dir.split("/")
    for (let i = 0; i + parts.length <= segs.length; i++) {
      if (parts.every((p, j) => segs[i + j] === p)) return dir
    }
  }
  const base = segs.at(-1) ?? ""
  for (const [glob, re] of FILE_RES) if (re.test(base)) return glob
  return null
}

function toPosix(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/")
}

/** cwd 밖으로 나가거나 비밀 경로 세그먼트를 건드리면 실패한다. */
export function resolveInside(cwd: string, raw: string): string {
  const value = (raw ?? "").trim()
  if (value.includes("\0")) fail("path_invalid", "NUL 문자는 허용되지 않는다")
  const rel = value === "" ? "." : value
  if (isAbsolute(rel)) fail("path_invalid", "절대 경로는 허용되지 않는다")
  const abs = resolve(cwd, rel)
  const fromCwd = relative(cwd, abs)
  if (fromCwd === ".." || fromCwd.startsWith(`..${sep}`) || isAbsolute(fromCwd)) {
    fail("path_invalid", "현재 디렉터리 밖은 허용되지 않는다")
  }
  const denied = deniedPath(toPosix(fromCwd) || ".")
  if (denied) fail("path_denied", `비밀 경로는 허용되지 않는다 (${denied})`)
  return abs
}

function deniedWritePath(rel: string): string | null {
  const segs = toPosix(rel).split("/").filter(Boolean)
  for (const dir of WRITE_DENY_DIRS) if (segs.includes(dir)) return dir
  return null
}

function isText(value: unknown): value is string {
  return typeof value === "string"
}

function assertText(value: unknown, code: string, message: string): asserts value is string {
  if (!isText(value)) fail(code, message)
  if (value.includes("\0")) fail(code, "NUL 문자는 허용되지 않는다")
}

/**
 * 쓰기 대상 경로를 검증한다. cwd 밖 탈출·비밀 경로·VCS 내부·심볼릭 링크를 거부하고,
 * 상위 디렉터리가 실제로 cwd 안에 있는지(심볼릭 링크 우회) 확인한다.
 */
export function validateWriteTarget(cwd: string, rawPath: string, content: string): string {
  assertText(content, "write_invalid", "내용이 문자열이 아니다")
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) fail("write_too_large", "내용이 너무 크다")
  const abs = resolveInside(cwd, rawPath)
  if (abs === resolve(cwd)) fail("path_invalid", "디렉터리에는 쓸 수 없다")
  const fromCwd = relative(cwd, abs)
  const denied = deniedWritePath(fromCwd)
  if (denied) fail("path_denied", `VCS 내부 경로는 쓸 수 없다 (${denied})`)

  let realCwd: string
  let realParent: string
  try {
    realCwd = realpathSync(cwd)
    realParent = realpathSync(dirname(abs))
  } catch {
    fail("write_failed", "상위 디렉터리를 찾을 수 없다")
  }
  const fromRealCwd = relative(realCwd, realParent)
  if (fromRealCwd === ".." || fromRealCwd.startsWith(`..${sep}`) || isAbsolute(fromRealCwd)) {
    fail("path_invalid", "현재 디렉터리 밖은 허용되지 않는다")
  }

  try {
    const stat = lstatSync(abs)
    if (stat.isSymbolicLink()) fail("write_failed", "심볼릭 링크에는 쓸 수 없다")
    if (!stat.isFile()) fail("write_failed", "일반 파일이 아니다")
  } catch (error) {
    if (error instanceof SafeError) throw error
    // 없는 파일은 새로 만든다
  }
  return abs
}

function atomicWrite(abs: string, content: string): number {
  let mode = 0o600
  try {
    mode = statSync(abs).mode & 0o777
  } catch {
    // 새 파일
  }
  const tmp = join(dirname(abs), `.croak-write-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode, flag: "wx" })
    renameSync(tmp, abs)
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      // 임시 파일 정리 실패는 무시한다
    }
    fail("write_failed", "파일을 쓸 수 없다")
  }
  return Buffer.byteLength(content, "utf8")
}

/** cwd 안의 텍스트 파일을 원자적으로 덮어쓴다(없으면 만든다). */
export function writeFileBounded(cwd: string, rawPath: string, content: string): number {
  const abs = validateWriteTarget(cwd, rawPath, content)
  return atomicWrite(abs, content)
}

/** cwd 안의 텍스트 파일에서 문자열을 바꾼다. 여러 곳 일치는 replaceAll 없이는 거부한다. */
export function editFileBounded(
  cwd: string,
  rawPath: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): number {
  assertText(oldString, "edit_invalid", "찾을 문자열이 올바르지 않다")
  assertText(newString, "edit_invalid", "바꿀 문자열이 올바르지 않다")
  if (oldString.length === 0) fail("edit_invalid", "찾을 문자열이 비어 있다")
  const abs = validateWriteTarget(cwd, rawPath, "")
  const text = readFileBounded(abs)

  let matches = 0
  let first = -1
  for (let i = text.indexOf(oldString); i >= 0; i = text.indexOf(oldString, i + oldString.length)) {
    matches += 1
    if (first < 0) first = i
  }
  if (matches === 0) fail("edit_no_match", "찾을 문자열이 파일에 없다")
  if (matches > 1 && !replaceAll) fail("edit_ambiguous", "여러 곳에서 일치한다. replaceAll을 사용하라")

  const next = replaceAll ? text.split(oldString).join(newString) : text.slice(0, first) + newString + text.slice(first + oldString.length)
  validateWriteTarget(cwd, rawPath, next)
  atomicWrite(abs, next)
  return matches
}

/** 삭제 대상 경로를 검증한다(존재·일반 파일·비심볼릭 링크·cwd 내부·비밀/VCS 경로). */
export function validateDeleteTarget(cwd: string, rawPath: string): string {
  const abs = validateWriteTarget(cwd, rawPath, "")
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(abs)
  } catch {
    fail("delete_failed", "삭제할 파일이 없다")
  }
  if (stat.isSymbolicLink()) fail("delete_failed", "심볼릭 링크는 삭제할 수 없다")
  if (!stat.isFile()) fail("delete_failed", "일반 파일이 아니다")
  return abs
}

/** cwd 안의 텍스트 파일을 삭제한다. 검증에 실패하면 아무것도 지우지 않는다. */
export function deleteFileBounded(cwd: string, rawPath: string): void {
  const abs = validateDeleteTarget(cwd, rawPath)
  try {
    unlinkSync(abs)
  } catch {
    fail("delete_failed", "파일을 삭제할 수 없다")
  }
}

export function validateFilename(raw: string): string {
  if (!raw) fail("filename_invalid", "파일 이름이 비어 있다")
  if (raw.includes("/") || raw.includes("\\")) fail("filename_invalid", "경로 구분자는 허용되지 않는다")
  if (raw === "." || raw === "..") fail("filename_invalid", "상대 경로 표기는 허용되지 않는다")
  if (raw.includes("\0")) fail("filename_invalid", "NUL 문자는 허용되지 않는다")
  if (basename(raw) !== raw) fail("filename_invalid", "최상위 파일 이름만 허용된다")
  const denied = deniedPath(raw)
  if (denied) fail("filename_denied", `비밀 파일 이름은 허용되지 않는다 (${denied})`)
  const cwdDenied = deniedPath(join(process.cwd(), raw))
  if (cwdDenied) fail("filename_denied", `비밀 경로 세그먼트는 허용되지 않는다 (${cwdDenied})`)
  return raw
}

export function readFileBounded(filename: string): string {
  let fd: number
  try {
    fd = openSync(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
  } catch {
    fail("read_failed", "파일을 열 수 없다")
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) fail("read_failed", "일반 파일이 아니다")
    if (stat.size > MAX_FILE_BYTES) fail("read_failed", "파일이 너무 크다")
    const buffer = Buffer.alloc(READ_LIMIT)
    let total = 0
    while (total < READ_LIMIT) {
      const n = readSync(fd, buffer, total, READ_LIMIT - total, total)
      if (n <= 0) break
      total += n
    }
    if (total > MAX_FILE_BYTES) fail("read_failed", "파일이 너무 크다")
    const bytes = buffer.subarray(0, total)
    if (bytes.includes(0)) fail("read_failed", "NUL 문자가 포함되어 있다")
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      fail("read_failed", "UTF-8로 해석할 수 없다")
    }
  } finally {
    try {
      closeSync(fd)
    } catch {
      // 닫기 실패는 무시한다
    }
  }
}
