// Project config behind the croak gate.
//
// croakcode reads .croakcode/croakcode.jsonc and croakcode.json(c) found in the
// project, the way upstream does. A cloned repository writes those files, not
// the user. They could read the user's environment and home files ({env:} and
// {file:~/...}) and send them out through a remote MCP server or an instruction
// URL, or run code through plugins, local MCP servers, lsp, formatter and shell.
//
// Behind the gate a project's config is used in full only after the user
// trusts it. Until then only the keys in KEEP are read, {env:} is not
// substituted, and {file:} reads only files inside the project. The decision is
// kept per project with a fingerprint of its config files, so a change to them
// (a pull that adds an MCP server) asks again.
//
// Plain sync code without Effect: the config loader (server) and the TUI both
// use it and must agree on what is ignored.

import crypto from "crypto"
import fs from "fs"
import { Global } from "@croakcode/core/global"
import path from "path"
import { parse as parseJsonc } from "jsonc-parser"

/** Keys an untrusted project config may set. Everything else is ignored. */
const KEEP = new Set([
  "$schema",
  "agent",
  "mode",
  "command",
  "instructions",
  "tools",
  "model",
  "small_model",
  "default_agent",
  "username",
  "layout",
  "watcher",
  "snapshot",
  "compaction",
  "tool_output",
  "attachment",
])

/** Agent fields an untrusted project may not set: they loosen what the agent may do. */
const AGENT_DROP = ["permission", "tools", "options"]

const CONFIG_NAMES = ["croakcode.jsonc", "croakcode.json"]
/** The TUI's config; its "plugin" list runs code in the TUI. */
const TUI_NAMES = ["tui.jsonc", "tui.json"]

export type Inspection = {
  /** The project the decision is kept for: the git worktree, else the directory. */
  root: string
  /** Project config files (croakcode.json[c]) from the directory up to the worktree. */
  files: string[]
  /** Project .croakcode folders, real paths. */
  dirs: string[]
  /** sha256 of every file above and every file inside those folders. */
  fingerprint: string
  /** What an untrusted load leaves out, for the question to the user. */
  ignored: string[]
}

export type Decision = "trusted" | "declined"

export function trustRoot(directory: string, worktree?: string) {
  return worktree && worktree !== "/" ? worktree : directory
}

function real(p: string) {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

function exists(p: string) {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}

function isDir(p: string) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** The same walk as ConfigPaths.files and ConfigPaths.directories, minus the user's own folders. */
export function projectSources(directory: string, worktree: string | undefined, home = Global.Path.home) {
  const own = new Set([real(path.join(home, ".croakcode"))])
  const files: string[] = []
  const dirs: string[] = []
  let current = directory
  while (true) {
    for (const name of [...CONFIG_NAMES, ...TUI_NAMES]) {
      const file = path.join(current, name)
      if (exists(file) && !isDir(file)) files.push(file)
    }
    const dir = path.join(current, ".croakcode")
    if (isDir(dir) && !own.has(real(dir))) dirs.push(real(dir))
    if (worktree === current) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return { files, dirs: [...new Set(dirs)] }
}

function walk(dir: string, out: string[]) {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "node_modules" || entry.name === ".git") continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
}

function fingerprintOf(files: string[], dirs: string[]) {
  const all = [...files]
  for (const dir of dirs) walk(dir, all)
  const hash = crypto.createHash("sha256")
  for (const file of [...new Set(all)].sort()) {
    hash.update(file + "\0")
    try {
      hash.update(fs.readFileSync(file))
    } catch {}
    hash.update("\0")
  }
  return hash.digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** A path an untrusted project may name: relative, inside the project, not a URL. */
export function insideProject(value: string) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false
  if (value.startsWith("~") || path.isAbsolute(value)) return false
  return !value.split(/[\\/]/).includes("..")
}

function sanitizeAgents(value: unknown, field: string, ignored: string[]) {
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [name, agent] of Object.entries(value)) {
    if (!isRecord(agent)) {
      out[name] = agent
      continue
    }
    const kept = { ...agent }
    for (const key of AGENT_DROP) {
      if (key in kept) {
        delete kept[key]
        ignored.push(`${field}.${name}.${key}`)
      }
    }
    out[name] = kept
  }
  return out
}

/** The part of an untrusted project config croakcode reads, and what it left out. */
export function sanitize(info: Record<string, unknown>) {
  const ignored: string[] = []
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(info)) {
    if (!KEEP.has(key)) {
      ignored.push(key)
      continue
    }
    if (key === "agent" || key === "mode") {
      kept[key] = sanitizeAgents(value, key, ignored)
      continue
    }
    if (key === "instructions" && Array.isArray(value)) {
      const ok = value.filter((item) => typeof item === "string" && insideProject(item))
      if (ok.length !== value.length) ignored.push("instructions (프로젝트 밖 경로, URL)")
      kept[key] = ok
      continue
    }
    if (key === "tools" && isRecord(value)) {
      // Switching a tool off is fine; switching one on is the user's call.
      const off = Object.fromEntries(Object.entries(value).filter(([, on]) => on === false))
      if (Object.keys(off).length !== Object.keys(value).length) ignored.push("tools (켜기)")
      kept[key] = off
      continue
    }
    kept[key] = value
  }
  return { kept, ignored }
}

/** Agent files (agent/*.md, mode/*.md) parsed by ConfigAgent: drop what loosens them. */
export function sanitizeAgentFiles(agents: Record<string, Record<string, unknown>>) {
  const ignored: string[] = []
  const out = sanitizeAgents(agents, "agent", ignored) as Record<string, Record<string, unknown>>
  return { agents: out, ignored }
}

function readJsonc(file: string): Record<string, unknown> {
  try {
    const value = parseJsonc(fs.readFileSync(file, "utf8"), [], { allowTrailingComma: true })
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

function frontmatterKeys(file: string) {
  try {
    const text = fs.readFileSync(file, "utf8")
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (!match) return []
    return [...match[1].matchAll(/^([A-Za-z_]+)\s*:/gm)].map((m) => m[1])
  } catch {
    return []
  }
}

/** What an untrusted load of this project leaves out. Empty: nothing to ask. */
export function inspect(directory: string, worktree: string | undefined, home = Global.Path.home): Inspection {
  const { files, dirs } = projectSources(directory, worktree, home)
  const ignored: string[] = []
  const isTui = (file: string) => TUI_NAMES.includes(path.basename(file))
  const all = [...files, ...dirs.flatMap((dir) => [...CONFIG_NAMES, ...TUI_NAMES].map((name) => path.join(dir, name)))]
  for (const file of all.filter(isTui)) {
    if (exists(file) && "plugin" in readJsonc(file)) ignored.push(`${path.basename(file)} plugin`)
  }
  const configFiles = all.filter((file) => !isTui(file))
  for (const file of configFiles) {
    if (!exists(file)) continue
    const text = (() => {
      try {
        return fs.readFileSync(file, "utf8")
      } catch {
        return ""
      }
    })()
    if (/\{env:[^}]+\}/.test(text)) ignored.push("{env:} 치환")
    for (const match of text.matchAll(/\{file:([^}]+)\}/g)) {
      if (!insideProject(match[1])) {
        ignored.push("{file:} 프로젝트 밖 파일")
        break
      }
    }
    ignored.push(...sanitize(readJsonc(file)).ignored)
  }
  for (const dir of dirs) {
    for (const sub of ["plugin", "plugins"]) {
      const listed: string[] = []
      walk(path.join(dir, sub), listed)
      if (listed.length) ignored.push(`${path.basename(dir)}/${sub} (${listed.length}개 파일)`)
    }
    if (exists(path.join(dir, "package.json"))) ignored.push("package.json 의존성 설치")
    for (const sub of ["agent", "agents", "mode", "modes"]) {
      const listed: string[] = []
      walk(path.join(dir, sub), listed)
      for (const file of listed.filter((f) => f.endsWith(".md"))) {
        for (const key of frontmatterKeys(file).filter((k) => AGENT_DROP.includes(k))) {
          ignored.push(`${sub}/${path.basename(file, ".md")}.${key}`)
        }
      }
    }
  }
  return {
    root: trustRoot(directory, worktree),
    files,
    dirs,
    fingerprint: fingerprintOf(files, dirs),
    ignored: [...new Set(ignored)],
  }
}

/** The git worktree holding directory (a folder with .git), for callers that have no instance. */
export function findWorktree(directory: string) {
  let current = directory
  while (true) {
    if (exists(path.join(current, ".git"))) return current
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export function storePath(home = Global.Path.home) {
  return path.join(home, ".config", "croak", "trusted-projects.json")
}

type Store = { projects: Record<string, { fingerprint: string; decision: Decision; at: string }> }

function readStore(home: string): Store {
  try {
    const value = JSON.parse(fs.readFileSync(storePath(home), "utf8"))
    if (isRecord(value) && isRecord(value.projects)) return value as Store
  } catch {}
  return { projects: {} }
}

/** The user's decision for this project, when its config is unchanged since. */
export function decision(inspection: Inspection, home = Global.Path.home): Decision | undefined {
  const entry = readStore(home).projects[inspection.root]
  if (!entry || entry.fingerprint !== inspection.fingerprint) return undefined
  return entry.decision
}

export function record(inspection: Inspection, value: Decision, home = Global.Path.home) {
  const store = readStore(home)
  store.projects[inspection.root] = {
    fingerprint: inspection.fingerprint,
    decision: value,
    at: new Date().toISOString(),
  }
  const file = storePath(home)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** True when the project's config must be read in its restricted form. */
export function restricted(inspection: Inspection, home = Global.Path.home) {
  return inspection.ignored.length > 0 && decision(inspection, home) !== "trusted"
}

export * as ProjectTrust from "./project-trust"
