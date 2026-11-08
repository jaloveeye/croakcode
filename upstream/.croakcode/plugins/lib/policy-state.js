// Shared state for the runtime tool policy used by /net-off, /net-on, and
// /tool-status. The server plugin reads this file before every tool call; the
// slash commands write it. Kept separate from the plugin so tests can exercise
// the merge and file handling without an opencode host.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Tools that reach the internet through opencode's built-in web providers. */
export const NET_TOOLS = Object.freeze(["websearch", "webfetch"]);

export const policyFile = () =>
  process.env.CROAK_TOOL_POLICY_FILE ||
  path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "croak", "tool-policy.json");

const cleanList = (value) =>
  Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))]
    : [];

/** Returns a policy with only the fields this module understands. */
export function normalizePolicy(value) {
  if (!value || typeof value !== "object") return { deny: [], sessions: {} };
  const sessions = {};
  if (value.sessions && typeof value.sessions === "object") {
    for (const [sessionID, tools] of Object.entries(value.sessions)) {
      const list = cleanList(tools);
      if (list.length) sessions[sessionID] = list;
    }
  }
  return { deny: cleanList(value.deny), sessions };
}

/** Tool names denied for a session: global rules plus that session's rules. */
export function deniedFor(policy, sessionID) {
  const normalized = normalizePolicy(policy);
  return new Set([...normalized.deny, ...(sessionID ? normalized.sessions[sessionID] ?? [] : [])]);
}

const matches = (tool, pattern) =>
  pattern === "*" || (pattern.endsWith("*") ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern);

/** True when any global or session rule matches the tool name. */
export function isDenied(policy, sessionID, tool) {
  return [...deniedFor(policy, sessionID)].some((pattern) => matches(tool, pattern));
}

export async function readPolicy(file = policyFile()) {
  try {
    return normalizePolicy(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return normalizePolicy(undefined);
    throw error;
  }
}

/** Writes atomically so a concurrent server read never sees a partial file. */
export async function writePolicy(policy, file = policyFile()) {
  const normalized = normalizePolicy(policy);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify({ ...normalized, updatedAt: new Date().toISOString() }, null, 2) + "\n";
  await writeFile(tmp, body, "utf8");
  await rename(tmp, file);
  return normalized;
}

/**
 * Returns a reader bound to one file. It deliberately reads on every call: the
 * file is tiny, and mtime-based caching can miss two writes within the same
 * millisecond, which would leave a just-disabled tool usable.
 */
export function createPolicyReader(file = policyFile()) {
  return () => readPolicy(file);
}
