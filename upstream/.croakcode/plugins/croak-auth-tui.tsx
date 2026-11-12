/** @jsxImportSource @opentui/solid */
// /login, /logout, /whoami, /agent-perm and /chatkey for croak-gate.
//
// /login opens the croak login page in the Windows browser. After the user
// signs in, the page shows a one-time code; pasting it here finishes the login
// (the code only works together with this session's PKCE verifier).
import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { createSignal, Show } from "solid-js"
import { readPolicy, writePolicy } from "./lib/policy-state.js"
import * as S from "./lib/croak-auth-session.js"

/** TUI kv key the agent list is filtered by (context/local.tsx). */
const ALLOWED_AGENTS_KEY = "croak_allowed_agents"

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

/**
 * Copies text with the system's clipboard program. False when there is none:
 * the dialog still shows the text to copy by hand.
 */
function copyText(text: string): boolean {
  const tries: [string, string[]][] =
    process.platform === "win32"
      ? [["clip.exe", []]]
      : process.platform === "darwin"
        ? [["pbcopy", []]]
        : [
            ["/mnt/c/Windows/System32/clip.exe", []],
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
          ]
  for (const [command, args] of tries) {
    try {
      const done = spawnSync(command, args, { input: text, timeout: 3000, stdio: ["pipe", "ignore", "ignore"] })
      if (done.status === 0) return true
    } catch {}
  }
  return false
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
  // Whether this TUI ever saw a login; the server deletes session.json on a 401.
  let loggedInOnce = Boolean(S.load())
  const reload = () => {
    if (S.load()) loggedInOnce = true
    setSession(currentSession())
  }
  const timer = setInterval(reload, 5000)
  api.lifecycle?.onDispose?.(() => clearInterval(timer))

  // The account whose conversation is open. The gate refuses a session that
  // another account started, so a different account gets a new session.
  const ownerKey = "croak_session_account"
  const lastAccount = () => api.kv?.get?.(ownerKey) as string | undefined
  const rememberAccount = (name: string | undefined) => api.kv?.set?.(ownerKey, name)
  if (session()?.user?.username) rememberAccount(session().user.username)

  // The agents this account's tier may use (shown in the agent list; the gate
  // still enforces). Without a login every agent stays listed.
  async function refreshAgents() {
    if (!currentSession()) return api.kv?.set?.(ALLOWED_AGENTS_KEY, undefined)
    try {
      const me = await S.whoami()
      const agents = me?.rules?.agents
      api.kv?.set?.(ALLOWED_AGENTS_KEY, Array.isArray(agents) && agents.length ? agents : undefined)
    } catch {
      // Keep the last list: the gate is unreachable now, and it enforces anyway.
    }
  }
  void refreshAgents()

  function openNewSession(reason: string) {
    if (api.route?.current?.name === "session") api.route.navigate("home")
    toast("info", "새 세션을 열었습니다", reason)
  }

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
    let url: string
    try {
      url = S.loginUrl(challenge)
    } catch (error: any) {
      // CROAK_AUTH_URL is not configured; there is no built-in server address.
      toast("error", "로그인할 수 없습니다", error?.message ?? String(error))
      return
    }
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
            const before = lastAccount()
            rememberAccount(u.username)
            void refreshAgents()
            if (before && u.username && before !== u.username)
              openNewSession(`${u.username} 계정으로 바뀌었습니다. 이전 세션은 ${before} 계정으로 다시 로그인하면 이어서 쓸 수 있습니다.`)
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
    void refreshAgents()
    toast(
      "info",
      had ? "로그아웃했습니다" : "로그인 상태가 아닙니다",
      had
        ? "같은 계정으로 /login하면 이 세션을 이어서 씁니다. 다른 계정으로 로그인하면 새 세션이 열립니다."
        : "/login으로 로그인하세요.",
    )
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

  // /chatkey: chat-only keys for a chat program on this PC (Open WebUI and the like).
  async function chatKey() {
    let listed: any
    try {
      listed = await S.chatKeys()
    } catch (error: any) {
      toast("error", "대화 전용 키를 읽지 못했습니다", error?.message ?? String(error))
      return
    }
    if (!listed) {
      toast("warning", "로그인하지 않았습니다", "/login으로 로그인한 뒤 다시 실행하세요.")
      return
    }
    const keys: any[] = listed.keys ?? []
    const DialogSelect = api.ui.DialogSelect
    api.ui.dialog.replace(() => (
      <DialogSelect
        title="대화 전용 키 (Open WebUI 같은 대화 프로그램용)"
        skipFilter
        options={[
          {
            title: "새 키 만들기",
            value: "new",
            description: `${keys.length}/${listed.limit}개 · 최대 ${listed.max_days}일`,
            disabled: keys.length >= listed.limit,
          },
          ...keys.map((k) => ({ title: k.name, value: k.id, description: `${when(k.expires_at)}까지 · 고르면 삭제` })),
        ]}
        onSelect={(opt: { value: string | number }) => {
          if (opt.value === "new") return askChatKeyName(listed)
          const key = keys.find((k) => k.id === opt.value)
          if (key) confirmChatKeyDelete(key)
        }}
      />
    ))
  }

  function askChatKeyName(listed: any) {
    const DialogPrompt = api.ui.DialogPrompt
    api.ui.dialog.replace(() => (
      <DialogPrompt
        title="새 대화 전용 키: 이름"
        description={() => <text fg={api.theme.current.textMuted}>어디에 쓰는 키인지 알아볼 이름입니다 (1~40자).</text>}
        placeholder="Open WebUI"
        onCancel={() => api.ui.dialog.clear()}
        onConfirm={(value: string) => {
          const name = value.trim() || "Open WebUI"
          askChatKeyDays(listed, name)
        }}
      />
    ))
  }

  function askChatKeyDays(listed: any, name: string) {
    const DialogPrompt = api.ui.DialogPrompt
    const [busy, setBusy] = createSignal(false)
    api.ui.dialog.replace(() => (
      <DialogPrompt
        title={`새 대화 전용 키: ${name} · 유효 기간(일)`}
        description={() => <text fg={api.theme.current.textMuted}>{`1~${listed.max_days}일. 비워 두면 30일입니다.`}</text>}
        placeholder="30"
        busy={busy()}
        busyText="만드는 중..."
        onCancel={() => api.ui.dialog.clear()}
        onConfirm={async (value: string) => {
          if (busy()) return
          const days = value.trim() ? Number(value.trim()) : undefined
          if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > listed.max_days)) {
            toast("warning", "유효 기간을 확인하세요", `1~${listed.max_days} 사이의 정수로 씁니다.`)
            return
          }
          setBusy(true)
          let made: any
          try {
            made = await S.createChatKey(name, days)
          } catch (error: any) {
            setBusy(false)
            toast("error", "키를 만들지 못했습니다", error?.message ?? String(error))
            return
          }
          if (!made?.key) {
            setBusy(false)
            toast("warning", "로그인하지 않았습니다", "/login으로 로그인한 뒤 다시 실행하세요.")
            return
          }
          showChatKey(made)
        }}
      />
    ))
  }

  function showChatKey(made: any) {
    const base = made.base_url || `${S.authUrl()}/v1`
    const copied = copyText(made.key)
    const DialogAlert = api.ui.DialogAlert
    api.ui.dialog.replace(() => (
      <DialogAlert
        title={`대화 전용 키를 만들었습니다: ${made.name}`}
        message={[
          `주소: ${base}`,
          `키: ${made.key}`,
          "",
          copied ? "키를 클립보드에 복사했습니다." : "클립보드에 복사하지 못했습니다. 위의 키를 직접 복사하세요.",
          "키는 지금 한 번만 보입니다. 닫으면 다시 볼 수 없습니다.",
          "",
          "Open WebUI의 OpenAI API 연결에 이 주소와 키를 넣으세요.",
          `대화 프로그램이 게이트 인증서(${S.caFile()})를 신뢰해야 연결됩니다.`,
          `이 키로는 도구를 쓸 수 없습니다. ${when(made.expires_at)}까지 씁니다. 이 PC에서만 쓰세요.`,
        ].join("\n")}
        onConfirm={() => api.ui.dialog.clear()}
      />
    ))
  }

  function confirmChatKeyDelete(key: any) {
    const DialogConfirm = api.ui.DialogConfirm
    api.ui.dialog.replace(() => (
      <DialogConfirm
        title={`'${key.name}' 키를 지울까요?`}
        message="지우면 이 키를 쓰는 대화 프로그램이 바로 연결되지 않습니다."
        onCancel={() => api.ui.dialog.clear()}
        onConfirm={async () => {
          try {
            await S.deleteChatKey(key.id)
            toast("info", `'${key.name}' 키를 지웠습니다`, "")
          } catch (error: any) {
            toast("error", "키를 지우지 못했습니다", error?.message ?? String(error))
          }
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
        name: "croak.chatkey",
        title: "Croak: 대화 전용 키 (Open WebUI 등)",
        category: "Croak",
        namespace: "palette",
        slashName: "chatkey",
        run: chatKey,
      },
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
    // The gate refused a session another account started (a login made outside
    // this TUI, or an old session reopened): move to a new one.
    if (/foreign_session|다른 계정이 시작한 세션/.test(text)) {
      openNewSession("이 세션은 다른 계정이 시작했습니다. 지금 계정으로 새 세션에서 다시 시작하세요.")
      return
    }
    if (/\b401\b|Authentication Error|invalid.*key|expired/i.test(text)) {
      if (loggedInOnce || S.load()) toast("warning", "다시 로그인하세요", "로그인이 끝났습니다. /login으로 다시 로그인하세요.")
      else toast("warning", "로그인하세요", "아직 로그인하지 않았습니다. /login으로 로그인하세요.")
    }
  })
}

export default { id: "croak-auth-tui", tui }
