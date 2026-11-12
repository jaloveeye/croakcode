// croakcode talks to models only through the croak gate. The launcher sets
// CROAK_AUTH_URL; when it is set, the gate's provider is the only one, and its
// address comes from that variable, never from a config file. A cloned
// project's .croakcode config could otherwise add a provider of its own, or
// point litellm-head (which carries the croak session token) at another server.

export const GATE_PROVIDER = "litellm-head"
export const GATE_NPM = "@ai-sdk/openai-compatible"

export type Gate = { provider: string; npm: string; baseURL: string }

export function croakGate(env: Record<string, string | undefined> = process.env): Gate | undefined {
  const url = env.CROAK_AUTH_URL?.trim().replace(/\/+$/, "")
  if (!url) return undefined
  return { provider: GATE_PROVIDER, npm: GATE_NPM, baseURL: url + "/v1" }
}

export const GATE_ONLY_MESSAGE = "croakcode는 croak 게이트의 모델만 씁니다."
