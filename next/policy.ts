// 실행 시 도구 정책. 기존 croakcode의 `tool-policy.json`과 같은 파일·형식을 쓴다.
//
// 다단 정책:
//   1) 전역 `deny`            — 모든 세션에 적용
//   2) `sessions["*"]`        — 모든 세션에 적용(전역과 같은 뜻)
//   3) `sessions[<세션 id>]`  — 그 세션에만 적용
// 패턴은 정확 일치, `*`(전부), `prefix*`(접두사)를 지원한다.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type Policy = {
  deny: string[]
  sessions: Record<string, string[]>
}

export function policyFile(): string {
  return (
    process.env.CROAK_TOOL_POLICY_FILE ||
    join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "croak", "tool-policy.json")
  )
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== "string") continue
    const trimmed = item.trim()
    if (trimmed) seen.add(trimmed)
  }
  return [...seen]
}

export function normalizePolicy(value: unknown): Policy {
  if (!value || typeof value !== "object") return { deny: [], sessions: {} }
  const raw = value as Record<string, unknown>
  const sessions: Record<string, string[]> = {}
  if (raw.sessions && typeof raw.sessions === "object" && !Array.isArray(raw.sessions)) {
    for (const [sessionID, tools] of Object.entries(raw.sessions as Record<string, unknown>)) {
      const list = cleanList(tools)
      if (list.length > 0) sessions[sessionID] = list
    }
  }
  return { deny: cleanList(raw.deny), sessions }
}

/** 도구 이름이 정책 패턴과 맞는가? (`*`, `prefix*`, 정확 일치) */
export function matches(pattern: string, tool: string): boolean {
  if (pattern === "*") return true
  if (pattern.endsWith("*")) return tool.startsWith(pattern.slice(0, -1))
  return pattern === tool
}

/** 전역 규칙과 해당 세션 규칙을 합친다. `sessions["*"]`도 전역으로 본다. */
export function deniedFor(policy: Policy, sessionID: string): string[] {
  const normalized = normalizePolicy(policy)
  return [
    ...normalized.deny,
    ...(normalized.sessions["*"] ?? []),
    ...(sessionID ? (normalized.sessions[sessionID] ?? []) : []),
  ]
}

export function isDenied(policy: Policy, sessionID: string, tool: string): boolean {
  return deniedFor(policy, sessionID).some((pattern) => matches(pattern, tool))
}

/** 세션별 규칙을 뺀 전역 규칙(`deny` + `sessions["*"]`)만 본다. */
export function globalDenied(policy: Policy, tool: string): boolean {
  const normalized = normalizePolicy(policy)
  return [...normalized.deny, ...(normalized.sessions["*"] ?? [])].some((pattern) => matches(pattern, tool))
}

/** 이 세션에만 걸린 규칙으로 도구가 꺼져 있는가? */
export function sessionDenied(policy: Policy, sessionID: string, tool: string): boolean {
  const normalized = normalizePolicy(policy)
  return (normalized.sessions[sessionID] ?? []).some((pattern) => matches(pattern, tool))
}

export function readPolicy(file = policyFile()): Policy {
  if (!existsSync(file)) return normalizePolicy(undefined)
  try {
    return normalizePolicy(JSON.parse(readFileSync(file, "utf8")))
  } catch {
    return normalizePolicy(undefined)
  }
}

/** 원자적으로 쓴다. 동시에 읽는 쪽이 반쯤 쓰인 파일을 보지 않는다. */
export function writePolicy(policy: Policy, file = policyFile()): Policy {
  const normalized = normalizePolicy(policy)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...normalized, updatedAt: new Date().toISOString() }, null, 2) + "\n", {
    mode: 0o600,
  })
  renameSync(tmp, file)
  return normalized
}

/** 이 세션의 도구 하나를 켜거나 끈다. 켠 상태(denied)와 바뀐 정책을 돌려준다. */
export function toggleSessionTool(
  sessionID: string,
  tool: string,
  file = policyFile(),
): { denied: boolean; policy: Policy } {
  const policy = readPolicy(file)
  const list = new Set(policy.sessions[sessionID] ?? [])
  if (list.has(tool)) list.delete(tool)
  else list.add(tool)
  if (list.size > 0) policy.sessions[sessionID] = [...list]
  else delete policy.sessions[sessionID]
  writePolicy(policy, file)
  return { denied: list.has(tool), policy }
}
