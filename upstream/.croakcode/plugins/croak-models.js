// The models croakcode offers come from the croak gate's model registry
// (GET /v1/croak/models): each listed alias with its name, reasoning levels
// and limits. Which engine and model serve an alias stays at the gate, so
// changing them, or adding a level, needs no croakcode release.
//
// Runs in the config hook, before croakcode reads the providers. The last
// good list is cached; when the gate cannot be reached (or the user is not
// logged in) the cache is used, and without one the product config stays as
// it is.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import * as S from "./lib/croak-auth-session.js"

export const PROVIDER = "litellm-head"
export const cacheFile = () => path.join(S.configDir(), "models.json")
const FETCH_TIMEOUT_MS = 3000

/** croakcode's model entry for one item of the gate's list. */
export function toModel(item) {
  const levels = Array.isArray(item.levels) ? item.levels.filter((l) => typeof l === "string" && l) : []
  const limits = item.limits && typeof item.limits === "object" ? item.limits : {}
  return {
    name: String(item.display || item.id),
    ...(levels.length ? { variants: Object.fromEntries(levels.map((l) => [l, { reasoningEffort: l }])) } : {}),
    ...(Number.isInteger(limits.context) && Number.isInteger(limits.output)
      ? { limit: { context: limits.context, output: limits.output } }
      : {}),
  }
}

/** Puts the gate's models into the provider config; models only in the config (older aliases) stay. */
export function applyList(config, list) {
  const provider = config.provider?.[PROVIDER]
  if (!provider || !Array.isArray(list) || list.length === 0) return false
  provider.models = { ...(provider.models ?? {}) }
  for (const item of list) {
    if (!item || typeof item.id !== "string" || !item.id) continue
    provider.models[item.id] = { ...(provider.models[item.id] ?? {}), ...toModel(item) }
  }
  return true
}

function readCache() {
  try {
    const list = JSON.parse(readFileSync(cacheFile(), "utf8"))
    return Array.isArray(list) ? list : null
  } catch {
    return null
  }
}

function writeCache(list) {
  try {
    mkdirSync(S.configDir(), { recursive: true, mode: 0o700 })
    const tmp = `${cacheFile()}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n", { mode: 0o600 })
    renameSync(tmp, cacheFile())
  } catch {
    // A cache that cannot be written only means the next start asks the gate again.
  }
}

async function fetchList() {
  let timer
  const timeout = new Promise((resolve) => (timer = setTimeout(() => resolve(null), FETCH_TIMEOUT_MS)))
  try {
    return await Promise.race([S.gateModels().catch(() => null), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export const server = async () => ({
  config: async (config) => {
    const fresh = await fetchList()
    if (Array.isArray(fresh) && fresh.length) writeCache(fresh)
    applyList(config, Array.isArray(fresh) && fresh.length ? fresh : readCache())
  },
})

export default { id: "croak-models", server }
