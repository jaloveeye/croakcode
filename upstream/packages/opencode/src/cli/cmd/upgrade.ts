import { UI } from "../ui"
import { CroakUpdate } from "@/croak-update"

export const UpgradeCommand = {
  command: "upgrade",
  describe: "upgrade croakcode from the gate",
  handler: async () => {
    try {
      const status = await CroakUpdate.check({ force: true })
      if (status.kind === "current") {
        UI.println("현재 최신 버전입니다.")
        return
      }
      UI.println(`croakcode ${status.manifest.latest} 업데이트를 받습니다.`)
      const result = await CroakUpdate.install(status.manifest)
      UI.println(result.restartRequired ? "업데이트를 받았습니다. croakcode를 다시 실행하세요." : "업데이트를 마쳤습니다.")
    } catch (error) {
      UI.error(`업데이트 실패: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  },
}
