/** @jsxImportSource @opentui/solid */
// /login, /logout, /whoami and /agent-perm for croak-gate.
//
// /login opens the croak login page in the Windows browser. After the user
// signs in, the page shows a one-time code; pasting it here finishes the login
// (the code only works together with this session's PKCE verifier).
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createSignal, Show } from "solid-js"
import { readPolicy, writePolicy } from "./lib/policy-state.js"
import * as S from "./lib/croak-auth-session.js"

/** Tools a user may switch off for one session with /agent-perm. */
const SESSION_TOOLS = ["bash", "edit", "write", "webfetch", "websearch"]
const CMD = "/mnt/c/Windows/System32/cmd.exe"

function openBrowser(url: string): boolean {
  try {
    if (existsSync(CMD)) {
      // WSL: the Windows default browser. cwd avoids cmd.exe's UNC path warning.
      spawn(CMD, ["/c", "start", "", url], { cwd: "/mnt/c", detached: true, stdio: "ignore" }).unref()
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref()
    }
    return true
  } catch {
    return false
  }
}

const KST = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "long",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
})
export const when = (iso?: string) => (iso ? KST.format(new Date(iso)) : "-")

const TIER_NAMES: Record<string, string> = { full: "전체", standard: "일반", restricted: "제한" }
const ROLE_NAMES: Record<string, string> = { admin: "관리자", auditor: "보안 담당" }

const matches = (name: string, pattern: string) =>
  pattern === "*" || (pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern)

/** Who is logged in, read from session.json. Undefined when logged out or the week is over. */
function currentSession() {
  const s = S.load()
  return s && Date.parse(s.session_expires_at) > Date.now() ? s : undefined
}

const tui = async (api: any) => {
  const toast = (variant: string, title: string, message: string) =>
    api.ui.toast({ variant, title, message, duration: 8000 })

  // The server plugin may refresh or clear the file, so poll it as well.
  const [session, setSession] = createSignal(currentSession())
  const reload = () => setSession(currentSession())
  const timer = setInterval(reload, 5000)
  api.lifecycle?.onDispose?.(() => clearInterval(timer))

  function Account(props: { compact?: boolean }) {
    const theme = () => api.theme.current
    return (
      <Show
        when={session()}
        fallback={
          <text fg={theme().warning}>
            ○ 로그인하지 않음 <span style={{ fg: theme().textMuted }}>· /login</span>
          </text>
        }
      >
        {(s) => (
          <box>
            <text>
              <span style={{ fg: theme().success }}>● </span>
              <span style={{ fg: theme().text }}>
                <b>{s().user?.username}</b>
              </span>
              <span style={{ fg: theme().textMuted }}> · {TIER_NAMES[s().user?.tier] ?? s().user?.tier} 등급</span>
            </text>
            <Show when={!props.compact}>
              <text fg={theme().textMuted}>로그인 유지 {when(s().session_expires_at)}까지</text>
            </Show>
          </box>
        )}
      </Show>
    )
  }

  api.slots.register({
    order: 5,
    slots: {
      sidebar_content() {
        return <Account />
      },
      home_prompt_right() {
        return <Account compact />
      },
    },
  })

  function login() {
    const { verifier, challenge } = S.pkce()
    const url = S.loginUrl(challenge)
    const opened = openBrowser(url)
    const [busy, setBusy] = createSignal(false)
    const DialogPrompt = api.ui.DialogPrompt
    api.ui.dialog.replace(() => (
      <DialogPrompt
        title="croak 로그인"
        description={() => (
          <box>
            <text fg={api.theme.current.textMuted}>
              {opened ? "브라우저에서 로그인 페이지를 열었습니다." : "아래 주소를 브라우저에서 여세요."}
            </text>
            <text fg={api.theme.current.text}>{url}</text>
            <text fg={api.theme.current.textMuted}>로그인한 뒤 화면에 나온 확인 코드를 붙여 넣으세요.</text>
          </box>
        )}
        placeholder="ABCD-EFGH-JKMN"
        busy={busy()}
        busyText="확인하는 중..."
        onCancel={() => api.ui.dialog.clear()}
        onConfirm={async (value: string) => {
          if (!value.trim() || busy()) return
          setBusy(true)
          try {
            const started = await S.exchange(value, verifier)
            api.ui.dialog.clear()
            reload()
            const u = started.user ?? {}
            toast("success", `${u.username}님, 로그인했습니다`, `${TIER_NAMES[u.tier] ?? u.tier} 등급 · ${when(started.session_expires_at)}까지`)
          } catch (error: any) {
            setBusy(false)
            toast("error", "로그인하지 못했습니다", error?.message ?? String(error))
          }
        }}
      />
    ))
  }

  async function logout() {
    const had = await S.logout()
    reload()
    toast("info", had ? "로그아웃했습니다" : "로그인 상태가 아닙니다", had ? "다시 쓰려면 /login을 실행하세요." : "/login으로 로그인하세요.")
  }

  async function whoami() {
    let me: any
    try {
      me = await S.whoami()
    } catch (error: any) {
      toast("error", "사용자 정보를 읽지 못했습니다", error?.message ?? String(error))
      return
    }
    if (!me) {
      toast("warning", "로그인하지 않았습니다", "/login으로 로그인하세요.")
      return
    }
    const rules = me.rules ?? {}
    const roles = (me.roles ?? []).map((r: string) => ROLE_NAMES[r] ?? r).join(", ") || "없음"
    const DialogAlert = api.ui.DialogAlert
    api.ui.dialog.replace(() => (
      <DialogAlert
        title={`${me.username} · ${TIER_NAMES[me.tier] ?? me.tier} 등급`}
        message={[
          `관리 권한: ${roles}`,
          `쓸 수 있는 에이전트: ${(rules.agents ?? []).join(", ") || "-"}`,
          `금지 도구: ${(rules.deny_tools ?? []).join(", ") || "없음"}`,
          `비밀정보 검사: ${rules.secrets_scope === "all" ? "대화 전체" : "새 메시지"}`,
          `로그인 유지: ${when(me.session_expires_at)}까지`,
        ].join("\n")}
        onConfirm={() => api.ui.dialog.clear()}
      />
    ))
  }

  async function agentPerm() {
    const sessionID = api.route.current?.params?.sessionID
    if (typeof sessionID !== "string") {
      toast("warning", "세션에서 실행하세요", "/agent-perm은 열린 세션의 도구를 바꿉니다.")
      return
    }
    let me: any = null
    try {
      me = await S.whoami()
    } catch {}
    const tierDenied: string[] = me?.rules?.deny_tools ?? []
    // readPolicy() is untyped JavaScript (plugins/lib/policy-state.js). The host
    // type checker sees only the declared JSDoc-free shape, so pin it here.
    const policy = await readPolicy() as { deny: string[]; sessions: Record<string, string[]> }
    const off = new Set<string>(policy.sessions[sessionID] ?? [])
    const globalOff = new Set<string>(policy.deny)
    const DialogSelect = api.ui.DialogSelect
    api.ui.dialog.replace(() => (
      <DialogSelect
        title="이 세션의 도구"
        skipFilter
        options={SESSION_TOOLS.map((tool) => {
          const byTier = tierDenied.some((p) => matches(tool, p))
          const state = byTier ? "등급에서 금지" : globalOff.has(tool) ? "전역으로 꺼짐" : off.has(tool) ? "꺼짐" : "켜짐"
          return { title: tool, value: tool, description: state, disabled: byTier || globalOff.has(tool) }
        })}
        onSelect={async (opt: { value: string }) => {
          const next = await readPolicy() as { deny: string[]; sessions: Record<string, string[]> }
          const list = new Set<string>(next.sessions[sessionID] ?? [])
          if (list.has(opt.value)) list.delete(opt.value)
          else list.add(opt.value)
          next.sessions[sessionID] = [...list]
          await writePolicy(next)
          toast("info", `${opt.value}: ${list.has(opt.value) ? "껐습니다" : "켰습니다"}`, "이 세션에만 적용됩니다. 등급보다 넓힐 수는 없습니다.")
          void agentPerm()
        }}
      />
    ))
  }

  api.keymap.registerLayer({
    commands: [
      { name: "croak.login", title: "Croak: 로그인", category: "Croak", namespace: "palette", slashName: "login", run: login },
      { name: "croak.logout", title: "Croak: 로그아웃", category: "Croak", namespace: "palette", slashName: "logout", run: logout },
      { name: "croak.whoami", title: "Croak: 내 권한 보기", category: "Croak", namespace: "palette", slashName: "whoami", run: whoami },
      {
        name: "croak.agent-perm",
        title: "Croak: 이 세션의 도구 끄고 켜기",
        category: "Croak",
        namespace: "palette",
        slashName: "agent-perm",
        run: agentPerm,
      },
    ],
  })

  // Tell the user when the gate rejects the token (weekly logout, revoke, lock).
  api.event?.on?.("session.error", (event: any) => {
    const text = JSON.stringify(event?.properties?.error ?? "")
    if (/\b401\b|Authentication Error|invalid.*key|expired/i.test(text)) {
      toast("warning", "다시 로그인하세요", "로그인이 끝났습니다. /login으로 다시 로그인하세요.")
    }
  })
}

export default { id: "croak-auth-tui", tui }
