// Commands that would connect croakcode to an outside service past the croak
// gate: an upstream console account (console.croakcode.ai, not this project's),
// the upstream GitHub app (api.croakcode.ai), and credentials for another model
// provider. Behind the gate they stop before doing anything.

const BLOCKED: Record<string, string[] | true> = {
  console: true,
  github: true,
  providers: ["login"],
  auth: ["login"],
}

// words: the command words yargs parsed (argv._), without options.
export function outsideGateCommand(words: string[]): string | undefined {
  const [command, sub] = words
  if (!command) return undefined
  const rule = BLOCKED[command]
  if (!rule) return undefined
  if (rule !== true && !rule.includes(sub ?? "")) return undefined
  return rule === true ? command : `${command} ${sub}`
}

export function outsideGateMessage(command: string) {
  return `croakcode ${command}: croak 게이트를 거치지 않는 외부 서비스에 연결하는 명령이라 쓸 수 없습니다.`
}
