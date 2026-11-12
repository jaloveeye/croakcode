import type { TuiPlugin, TuiPluginApi } from "@croakcode/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { updateBusy, updateLatest, upgradeNow } from "@tui/croak-upgrade"
import { createMemo, Show } from "solid-js"
import { Global } from "@croakcode/core/global"

const id = "internal:sidebar-footer"

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const has = createMemo(() => props.api.state.provider.length > 0)
  const done = createMemo(() => props.api.kv.get("dismissed_getting_started", false))
  const show = createMemo(() => !has() && !done())
  const path = createMemo(() => {
    const dir = props.api.state.path.directory || process.cwd()
    const out = dir.replace(Global.Path.home, "~")
    const text = props.api.state.vcs?.branch ? out + ":" + props.api.state.vcs.branch : out
    const list = text.split("/")
    return {
      parent: list.slice(0, -1).join("/"),
      name: list.at(-1) ?? "",
    }
  })

  return (
    <box gap={1}>
      <Show when={show()}>
        <box
          backgroundColor={theme().backgroundElement}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          flexDirection="row"
          gap={1}
        >
          <text flexShrink={0} fg={theme().text}>
            ⬖
          </text>
          <box flexGrow={1} gap={1}>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().text}>
                <b>Getting started</b>
              </text>
              <text fg={theme().textMuted} onMouseDown={() => props.api.kv.set("dismissed_getting_started", true)}>
                ✕
              </text>
            </box>
            <text fg={theme().textMuted}>
              croakcode는 croak 게이트의 사내 모델을 씁니다. 로그인하면 바로 시작합니다.
            </text>
            <box flexDirection="row" gap={1} justifyContent="space-between">
              <text fg={theme().text}>croak 로그인</text>
              <text fg={theme().textMuted}>/login</text>
            </box>
          </box>
        </box>
      </Show>
      <text>
        <span style={{ fg: theme().textMuted }}>{path().parent}/</span>
        <span style={{ fg: theme().text }}>{path().name}</span>
      </text>
      <text fg={theme().textMuted}>
        <span style={{ fg: theme().success }}>•</span> <b>Croak</b>
        <span style={{ fg: theme().text }}>
          <b>Code</b>
        </span>{" "}
        <span>{props.api.app.version}</span>
      </text>
      <Show when={updateLatest()}>
        <text
          fg={theme().warning}
          onMouseUp={() => void upgradeNow((variant, message) => props.api.ui.toast({ variant, message, duration: 8000 }))}
        >
          {updateBusy() ? "업데이트를 받는 중..." : `새 버전 ${updateLatest()} (지금 ${props.api.app.version})`}
        </text>
        <text fg={theme().textMuted}>눌러서 업데이트 · /upgrade</text>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_footer() {
        return <View api={api} />
      },
    },
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
