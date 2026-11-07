import { BusEvent } from "@/bus/bus-event"
import { Schema } from "effect"
import { NamedError } from "@croakcode/core/util/error"
import * as Log from "@croakcode/core/util/log"
import { Process } from "@/util/process"

const SUPPORTED_IDES = [
  { name: "Windsurf" as const, cmd: "windsurf" },
  { name: "Visual Studio Code - Insiders" as const, cmd: "code-insiders" },
  { name: "Visual Studio Code" as const, cmd: "code" },
  { name: "Cursor" as const, cmd: "cursor" },
  { name: "VSCodium" as const, cmd: "codium" },
]

const log = Log.create({ service: "ide" })

export const Event = {
  Installed: BusEvent.define(
    "ide.installed",
    Schema.Struct({
      ide: Schema.String,
    }),
  ),
}

export const AlreadyInstalledError = NamedError.create("AlreadyInstalledError", {})

export const InstallFailedError = NamedError.create("InstallFailedError", {
  stderr: Schema.String,
})

export function ide() {
  if (process.env["TERM_PROGRAM"] === "vscode") {
    const v = process.env["GIT_ASKPASS"]
    for (const ide of SUPPORTED_IDES) {
      if (v?.includes(ide.name)) return ide.name
    }
  }
  return "unknown"
}

export function alreadyInstalled() {
  return process.env["CROAKCODE_CALLER"] === "vscode" || process.env["CROAKCODE_CALLER"] === "vscode-insiders"
}

export async function install(ide: (typeof SUPPORTED_IDES)[number]["name"]) {
  const cmd = SUPPORTED_IDES.find((i) => i.name === ide)?.cmd
  if (!cmd) throw new Error(`Unknown IDE: ${ide}`)

  // croakcode는 아직 전용 IDE 확장을 배포하지 않는다. upstream 확장 ID를 그대로 설치하면
  // 사용자 IDE에 무관한 타사 확장이 설치되므로 명시적으로 실패시킨다(Phase 2에서 자체 확장 도입 시 교체).
  throw new InstallFailedError({ stderr: "croakcode IDE extension is not published yet" })
}

export * as Ide from "."
