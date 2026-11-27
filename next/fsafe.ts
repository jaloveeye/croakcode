import { constants as fsConstants, closeSync, fstatSync, openSync, readSync } from "node:fs"
import { basename, join } from "node:path"

export const MAX_FILE_BYTES = 16 * 1024
const READ_LIMIT = MAX_FILE_BYTES + 1

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
