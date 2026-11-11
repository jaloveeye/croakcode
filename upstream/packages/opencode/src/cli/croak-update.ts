import * as prompts from "@clack/prompts"
import { InstallationVersion } from "@croakcode/core/installation/version"
import { CroakUpdate } from "@/croak-update"
import semver from "semver"

// Return false when the current process must not enter the application.
export async function beforeStart(args: string[]): Promise<boolean> {
  delete process.env.CROAKCODE_UPDATE_LATEST
  if (!semver.valid(InstallationVersion) || !process.env.CROAK_AUTH_URL ||
      args[0] === "upgrade" || (args.length === 1 && ["--version", "-v", "--help", "-h"].includes(args[0]))) return true
  let status: CroakUpdate.UpdateStatus
  try {
    status = await CroakUpdate.check()
  } catch {
    // The gateway remains the final authority on the minimum version.
    return true
  }
  if (status.kind === "current") return true
  process.env.CROAKCODE_UPDATE_LATEST = status.manifest.latest
  if (status.kind === "optional") return true
  process.stderr.write(`croakcode ${status.manifest.minimum} 이상이 필요합니다.\n`)
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    process.stderr.write("croakcode upgrade를 실행하세요.\n")
    return false
  }
  const answer = await prompts.confirm({ message: `${status.manifest.latest} 버전으로 업데이트할까요?`, initialValue: true })
  if (prompts.isCancel(answer) || !answer) return false
  try {
    const result = await CroakUpdate.install(status.manifest)
    if (result.restartRequired) {
      process.stderr.write("업데이트를 받았습니다. croakcode를 다시 실행하세요.\n")
      return false
    }
    const child = Bun.spawn([process.execPath, ...process.argv.slice(2)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
    process.exitCode = await child.exited
  } catch (error) {
    process.stderr.write(`업데이트 실패: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
  return false
}
