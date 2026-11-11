// Adds the logged-in user's access token to model requests for croak-gate.
//
// /login (tui.tsx) stores the session; this hook reads it, refreshes the
// token when it is about to expire, and sets `Authorization`. Without a
// session the provider's configured apiKey is used, and croak-gate rejects
// it once login is required.
//
// SECURITY (protected header contract): the Authorization token must NEVER be
// sent to an origin other than the Gate, nor in direct mode. It is injected only
// when ALL THREE conditions hold:
//   (a) provider id ∈ CROAK_PROVIDERS (default: litellm-head)
//   (b) resolved provider baseURL origin == Gate URL origin (CROAK_AUTH_URL)
//   (c) the effective connection mode is "gate"
// If any condition is missing/unknown we fail closed and do not attach it.
import { accessToken, authUrl } from "./lib/croak-auth-session.js";

/** Providers that point at croak-gate (croakcode.jsonc `provider` ids). */
const PROVIDERS = new Set((process.env.CROAK_PROVIDERS || "litellm-head").split(",").map((s) => s.trim()));

export const providerOf = (input) => input?.model?.providerID ?? input?.provider?.info?.id ?? input?.provider?.id;

const originOf = (value) => {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

/** Gate 전용 토큰을 이 요청에 실어도 되는가? (3중 조건) */
export function shouldAttachToken(input) {
  const providerID = providerOf(input);
  if (!providerID || !PROVIDERS.has(providerID)) return false;
  const mode = input?.connection?.mode;
  if (mode !== "gate") return false; // direct면 금지, 미상이면 fail-closed
  const base = input?.provider?.options?.baseURL ?? input?.provider?.info?.options?.baseURL;
  if (!base) return false;
  // Both origins must parse: two unparsable values compare equal as undefined.
  const gate = originOf(authUrl());
  const target = originOf(base);
  return gate !== undefined && target !== undefined && target === gate;
}

export const server = async () => ({
  "chat.headers": async (input, output) => {
    if (!shouldAttachToken(input)) return;
    if (process.env.CROAKCODE_CLIENT_VERSION) output.headers["x-croak-client-version"] = process.env.CROAKCODE_CLIENT_VERSION;
    const token = await accessToken();
    // Same spelling as the SDK's own header, so ours replaces it.
    if (token) output.headers.Authorization = `Bearer ${token}`;
  },
});

export default { id: "croak-auth", server };
