import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { configFile, dataDir, type Inbound } from "./paths"
import type { InboundMessage } from "./peers"

export type Settings = {
  inbound: Inbound
}

const DEFAULT_SETTINGS: Settings = { inbound: "hold" }

export function loadSettings(): Settings {
  const file = configFile()
  if (!existsSync(file)) return { ...DEFAULT_SETTINGS }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
  const inbound = (raw as { inbound?: unknown } | null)?.inbound
  return { inbound: inbound === "accept" || inbound === "hold" || inbound === "refuse" ? inbound : DEFAULT_SETTINGS.inbound }
}

export function saveSettings(settings: Settings): void {
  const file = configFile()
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(settings), { mode: 0o600 })
  renameSync(tmp, file)
}

/** 세션 이름별 보류 메시지 큐(halt 상태에서 받은 메시지)를 파일로 보존한다. */
export function heldFile(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "default"
  return join(dataDir(), "held", `${safe}.json`)
}

export function loadHeld(name: string): InboundMessage[] {
  const file = heldFile(name)
  if (!existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"))
    if (!Array.isArray(raw)) return []
    return raw.filter(isMessage)
  } catch {
    return []
  }
}

export function saveHeld(name: string, messages: InboundMessage[]): void {
  const file = heldFile(name)
  if (messages.length === 0) {
    try {
      unlinkSync(file)
    } catch {
      // 이미 없으면 무시한다
    }
    return
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(messages), { mode: 0o600 })
  renameSync(tmp, file)
}

function isMessage(value: unknown): value is InboundMessage {
  if (!value || typeof value !== "object") return false
  const m = value as Record<string, unknown>
  return (
    typeof m.id === "string" &&
    typeof m.from === "string" &&
    typeof m.fromName === "string" &&
    typeof m.text === "string" &&
    typeof m.ts === "number"
  )
}

/** 대상 세션 id별 idle 알림 구독자 목록 파일. */
function subsFile(targetId: string): string {
  const safe = targetId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128)
  return join(dataDir(), "subs", `${safe}.json`)
}

type Subscription = { by: string; expiresAt: number }

export function loadSubs(targetId: string): Subscription[] {
  const file = subsFile(targetId)
  if (!existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"))
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (s): s is Subscription =>
        !!s && typeof s === "object" && typeof s.by === "string" && typeof s.expiresAt === "number",
    )
  } catch {
    return []
  }
}

/** 대상 세션에 대한 구독을 추가한다(만료된 항목은 정리). */
export function addSub(targetId: string, subscriberId: string, expiresAt: number): void {
  const now = Date.now()
  const subs = loadSubs(targetId).filter((s) => s.expiresAt > now && s.by !== subscriberId)
  subs.push({ by: subscriberId, expiresAt })
  const file = subsFile(targetId)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(subs), { mode: 0o600 })
  renameSync(tmp, file)
}