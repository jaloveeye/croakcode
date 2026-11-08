// Tells croak-gate which opencode agent and session sent each request.
//
// croak-gate picks the data policy (personal data, secrets, prompt archive)
// from the agent name. The header can only tighten the rules: a looser profile
// also needs a grant on the API key, so a forged agent name gains nothing.
export const AGENT_HEADER = "x-croak-agent"
export const SESSION_HEADER = "x-croak-session"

export function identityHeaders(input) {
  const headers = {}
  if (input?.agent) headers[AGENT_HEADER] = String(input.agent)
  if (input?.sessionID) headers[SESSION_HEADER] = String(input.sessionID)
  return headers
}

export const server = async () => ({
  "chat.headers": async (input, output) => {
    Object.assign(output.headers, identityHeaders(input))
  },
})

export default { id: "croak-gate-identity", server }
