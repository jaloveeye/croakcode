// Asks once per project whether its own croakcode config may be used in full
// (config/project-trust.ts). Until the user trusts it, the server reads only
// the safe part; after trusting, the instance is reloaded with all of it.
import { ProjectTrust } from "@/config/project-trust"
import { croakGate } from "@/provider/croak-gate"
import { DialogConfirm } from "./ui/dialog-confirm"
import type { DialogContext } from "./ui/dialog"

const SHOWN = 8

export function trustMessage(root: string, ignored: string[]) {
  const listed = ignored.slice(0, SHOWN).map((item) => `  - ${item}`)
  if (ignored.length > SHOWN) listed.push(`  - 그 밖에 ${ignored.length - SHOWN}개`)
  return [
    `${root}`,
    "",
    "이 저장소의 croakcode 설정에 다음 항목이 있습니다. 신뢰하기 전에는 이 항목을 빼고 엽니다.",
    ...listed,
    "",
    "신뢰하면 이 설정이 코드를 실행하고, 환경 변수와 파일을 읽고, 게이트 밖으로 연결할 수 있습니다.",
    "저장소를 만든 사람을 믿을 때만 신뢰하세요. 설정 파일이 바뀌면 다시 묻습니다.",
  ].join("\n")
}

type Notify = (variant: "info" | "success" | "warning" | "error", message: string) => void

export async function askProjectTrust(input: {
  dialog: DialogContext
  directory: string
  worktree: string
  reload: () => Promise<unknown>
  notify: Notify
  /** /trust: ask again even after an earlier answer. */
  force?: boolean
}) {
  if (!croakGate()) {
    if (input.force) input.notify("info", "게이트에 연결하지 않은 실행에서는 저장소 설정을 그대로 읽습니다.")
    return
  }
  const inspection = ProjectTrust.inspect(input.directory, input.worktree)
  if (inspection.ignored.length === 0) {
    if (input.force) input.notify("info", "이 저장소에는 신뢰가 필요한 설정이 없습니다.")
    return
  }
  const before = ProjectTrust.decision(inspection)
  if (!input.force && before) return
  const answer = await DialogConfirm.show(
    input.dialog,
    "이 저장소의 설정을 신뢰할까요?",
    trustMessage(inspection.root, inspection.ignored),
    "신뢰 안 함",
    "신뢰",
    "cancel",
  )
  // esc: no answer yet; the question comes back next time.
  if (answer === undefined) return
  ProjectTrust.record(inspection, answer ? "trusted" : "declined")
  // The server read the config before this answer; reload when it changes what it reads.
  if (answer !== (before === "trusted")) await input.reload()
  const tui = inspection.ignored.some((item) => item.startsWith("tui."))
  if (answer)
    input.notify(
      "success",
      tui ? "저장소 설정을 모두 읽었습니다. TUI 플러그인은 croakcode를 다시 열면 적용됩니다." : "저장소 설정을 모두 읽었습니다.",
    )
  else input.notify("info", "저장소 설정의 위험 항목을 빼고 씁니다. /trust로 다시 정할 수 있습니다.")
}
