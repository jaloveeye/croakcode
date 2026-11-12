// croakcode: update from inside the TUI (the /upgrade command and the update
// notice in the footers), instead of quitting to run `croakcode upgrade`.
import { createSignal } from "solid-js"
import { CroakUpdate } from "@/croak-update"

type Notify = (variant: "info" | "success" | "warning" | "error", message: string) => void

// The version the startup check found newer than this one, if any (cli/croak-update.ts).
const [latest, setLatest] = createSignal(process.env.CROAKCODE_UPDATE_LATEST)
const [busy, setBusy] = createSignal(false)
export const updateLatest = latest
export const updateBusy = busy

/** Checks the gate now and installs a newer release; the running croakcode keeps its version until restarted. */
export async function upgradeNow(notify: Notify) {
  if (busy()) return
  setBusy(true)
  try {
    const status = await CroakUpdate.check({ force: true })
    if (status.kind === "current") {
      setLatest(undefined)
      notify("info", "이미 최신 버전입니다.")
      return
    }
    notify("info", `croakcode ${status.manifest.latest}을(를) 받는 중입니다.`)
    const result = await CroakUpdate.install(status.manifest)
    setLatest(undefined)
    notify(
      "success",
      result.restartRequired
        ? `${status.manifest.latest}을(를) 받았습니다. croakcode를 끝내고(ctrl+d) 다시 실행하면 바뀝니다.`
        : `${status.manifest.latest}(으)로 업데이트했습니다. croakcode를 끝내고(ctrl+d) 다시 실행하면 새 버전이 뜹니다.`,
    )
  } catch (error) {
    notify("error", `업데이트하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    setBusy(false)
  }
}
