import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import semver from "semver"
import { InstallationVersion } from "@croakcode/core/installation/version"
import { Flock } from "@croakcode/core/util/flock"

// How long a startup reuses the last manifest. The gate is on the local network
// and the manifest is small; a day made a new release show up a day late.
export const CHECK_INTERVAL_MS = 60 * 60 * 1000
const archiveName = /^croakcode-(\d+\.\d+\.\d+)-(linux-x64|linux-arm64|darwin-x64|darwin-arm64|windows-x64)\.(tar\.gz|zip)$/

type Entry = { file: string; sha256: string; size: number }
export type Manifest = { product: "croakcode"; latest: string; minimum: string; files: Record<string, Entry> }
type Cache = { gate: string; checkedAt: number; manifest: Manifest }
export type UpdateStatus = { kind: "current" | "optional" | "required"; manifest: Manifest }

function root() { return path.join(os.homedir(), ".config", "croak") }
function cachePath() { return path.join(root(), "update-cache.json") }

export function classify(manifest: Manifest, version: string): UpdateStatus {
  if (!semver.valid(version)) throw new Error("invalid installed version")
  const kind = semver.lt(version, manifest.minimum) ? "required" : semver.lt(version, manifest.latest) ? "optional" : "current"
  return { kind, manifest }
}

export function parseManifest(value: unknown): Manifest {
  if (!value || typeof value !== "object") throw new Error("invalid update manifest")
  const m = value as Record<string, unknown>
  if (m.product !== "croakcode" || typeof m.latest !== "string" || typeof m.minimum !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(m.latest) || !/^\d+\.\d+\.\d+$/.test(m.minimum) ||
      !semver.valid(m.latest) || !semver.valid(m.minimum) || semver.gt(m.minimum, m.latest) ||
      !m.files || typeof m.files !== "object" || Array.isArray(m.files)) throw new Error("invalid update manifest")
  return m as Manifest
}

function gateURL(): string {
  const value = process.env.CROAK_AUTH_URL ?? ""
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(value)) throw new Error("invalid gate URL")
  return value
}

async function download(url: string, timeout = 15_000): Promise<Response> {
  const caPath = process.env.CROAK_CA_FILE || process.env.NODE_EXTRA_CA_CERTS || path.join(root(), "ca", "ca.crt")
  const ca = await fs.readFile(caPath, "utf8")
  const response = await fetch(url, { tls: { ca }, signal: AbortSignal.timeout(timeout), redirect: "error" })
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
  return response
}

export async function check(options: { force?: boolean; now?: number; version?: string } = {}): Promise<UpdateStatus> {
  const gate = gateURL()
  const now = options.now ?? Date.now()
  const version = options.version ?? InstallationVersion
  let cache: Cache | undefined
  try {
    const data = JSON.parse(await fs.readFile(cachePath(), "utf8")) as Cache
    if (data.gate === gate && typeof data.checkedAt === "number" && data.checkedAt <= now && data.checkedAt > 0) {
      cache = { ...data, manifest: parseManifest(data.manifest) }
    }
  } catch {}
  if (!options.force && cache && now - cache.checkedAt < CHECK_INTERVAL_MS) return classify(cache.manifest, version)
  try {
    const response = await download(`${gate}/download/manifest.json`)
    const manifest = parseManifest(await response.json())
    const status = classify(manifest, version)
    try {
      await fs.mkdir(root(), { recursive: true, mode: 0o700 })
      const tmp = `${cachePath()}.${process.pid}.tmp`
      await fs.writeFile(tmp, JSON.stringify({ gate, checkedAt: now, manifest }), { mode: 0o600 })
      await fs.rename(tmp, cachePath())
    } catch {}
    return status
  } catch (error) {
    if (cache && !options.force) return classify(cache.manifest, version)
    throw error
  }
}

export function target(platform = process.platform, arch = process.arch): string {
  const osName = platform === "win32" ? "windows" : platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : ""
  if (!osName || !["x64", "arm64"].includes(arch) || (osName === "windows" && arch !== "x64")) throw new Error("unsupported platform")
  return `${osName}-${arch}`
}

export function entryFor(manifest: Manifest, platform = process.platform, arch = process.arch): Entry {
  const id = target(platform, arch)
  const entry = manifest.files[id]
  const match = typeof entry?.file === "string" ? archiveName.exec(entry.file) : null
  if (!match || match[1] !== manifest.latest || match[2] !== id || match[3] !== (id === "windows-x64" ? "zip" : "tar.gz") ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > 1024 ** 3) {
    throw new Error("invalid archive in manifest")
  }
  return entry
}

async function command(args: string[]): Promise<string> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`archive command failed: ${err.slice(0, 300)}`)
  return out
}

export async function install(manifest: Manifest): Promise<{ restartRequired: boolean }> {
  const home = os.homedir()
  const installed = path.join(home, ".local", "share", "croakcode", process.platform === "win32" ? "croakcode.exe" : "croakcode")
  if (path.resolve(process.execPath).toLowerCase() !== path.resolve(installed).toLowerCase()) {
    throw new Error("release installer로 설치한 croakcode에서만 업데이트할 수 있습니다")
  }
  const entry = entryFor(manifest)
  const lock = await Flock.acquire("release-update", { dir: root(), timeoutMs: 1_000 })
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "croak-update-")).catch(async (error) => {
    await lock.release()
    throw error
  })
  const archive = path.join(temp, entry.file)
  const config = path.join(home, ".croakcode")
  const backup = `${config}.update-backup-${Date.now()}-${process.pid}`
  const nextConfig = `${config}.update-new-${process.pid}`
  const nextBinary = `${installed}.update-new-${process.pid}`
  let saved = false
  let copied = false
  try {
    if (process.platform === "win32") {
      const pending = path.join(path.dirname(installed), "croakcode.pending.exe")
      if (await fs.stat(pending).then(() => true, () => false)) throw new Error("이미 받은 업데이트를 적용하려면 croakcode를 다시 실행하세요")
    }
    const response = await download(`${gateURL()}/download/${entry.file}`, 10 * 60_000)
    if (!response.body) throw new Error("empty archive response")
    const file = await fs.open(archive, "wx", 0o600)
    const digest = createHash("sha256")
    let size = 0
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value: chunk } = await reader.read()
        if (done) break
        size += chunk.length
        if (size > entry.size) throw new Error("archive exceeds declared size")
        digest.update(chunk)
        await file.writeFile(chunk)
      }
    } finally {
      reader.releaseLock()
      await file.close()
    }
    if (size !== entry.size || digest.digest("hex") !== entry.sha256) throw new Error("archive checksum mismatch")
    const names = (await command(["tar", "-tf", archive])).split(/\r?\n/).filter(Boolean)
    const listing = (await command(["tar", "-tvf", archive])).split(/\r?\n/).filter(Boolean)
    const executable = process.platform === "win32" ? "bin/croakcode.exe" : "bin/croakcode"
    if (!names.includes(executable) || names.some((name) => name !== executable && (!name.startsWith("config/") || name.split("/").some((part) => part === "." || part === ".."))) || listing.some((line) => !line.startsWith("-"))) {
      throw new Error("unsafe archive contents")
    }
    const extracted = path.join(temp, "extracted")
    await fs.mkdir(extracted)
    await command(["tar", "-xf", archive, "-C", extracted])
    const source = path.join(extracted, "bin", path.basename(installed))
    if (!(await fs.stat(source)).isFile() || !(await fs.stat(path.join(extracted, "config"))).isDirectory()) throw new Error("missing release files")
    await fs.copyFile(source, nextBinary)
    if (process.platform !== "win32") await fs.chmod(nextBinary, 0o755)
    await fs.cp(path.join(extracted, "config"), nextConfig, { recursive: true, errorOnExist: true, force: false })
    try { await fs.rename(config, backup); saved = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await fs.rename(nextConfig, config)
    copied = true
    const destination = process.platform === "win32" ? path.join(path.dirname(installed), "croakcode.pending.exe") : installed
    await fs.rename(nextBinary, destination)
    return { restartRequired: process.platform === "win32" }
  } catch (error) {
    if (copied) await fs.rm(config, { recursive: true, force: true })
    if (saved) await fs.rename(backup, config)
    throw error
  } finally {
    await fs.rm(nextBinary, { force: true })
    await fs.rm(nextConfig, { recursive: true, force: true })
    await lock.release()
    await fs.rm(temp, { recursive: true, force: true })
  }
}

export * as CroakUpdate from "."
