#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.argv[2] ?? "upstream";
// 저작권/라이선스 고지 파일은 "opencode"/"anomalyco" 표기가 허용된다.
const ALLOW = new Set(["NOTICE", "LICENSE", "README.md", "UPSTREAM"]);
// fork 운영 도구(설치 보조 스크립트)는 대상 리포 경로/브랜치를 참조하므로 예외.
const ALLOW_PATHS = new Set(["patches/install-korean-ime-fix.sh"]);
// 내부 워크스페이스 패키지 이름은 workspace:* 의존성 때문에 유지한다(다른 패키지가 "opencode"로 참조).
const ALLOW_PKG_NAMES = new Set(["packages/opencode/package.json", "packages/core/package.json"]);

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (/\.(ts|tsx|js|mjs|json|jsonc|sh|toml)$/.test(p)) out.push(p);
  }
  return out;
}

// 식별자/경로/명령/패키지명 수준의 잔여 브랜딩만 검사한다.
// (주석 속 "opencode"는 허용 — 상표 미사용은 배포물/식별자 기준이다.)
const FORBIDDEN = [
  [/OPENCODE_/, "env prefix OPENCODE_"],
  [/~\/\.local\/share\/opencode|---local-share-opencode/, "opencode data path"],
  [/scriptName\("opencode"\)/, 'cli scriptName "opencode"'],
  [/"name":\s*"opencode"/, 'package name "opencode"'],
  [/opencode-\$\{safe\}/, "channel DB template opencode-${safe}.db"],
  [/[\\/"]opencode[\\/"]\s*,\s*["']opencode\.db/, "desktop path segment opencode/opencode.db"],
  [/const base\s*=\s*"opencode-/, "binary base name opencode-"],
  // user-facing config/paths/URLs
  [/\.well-known\/opencode/, "well-known config path"],
  [/opencode\.ai/, "opencode.ai URL"],
  [/console\.opencode|api\.opencode|dev\.opencode/, "opencode service URL"],
  [/\.opencode\//, ".opencode directory"],
  [/"opencode\.jsonc?"/, "opencode.json filename"],
  [/opencode config are deprecated|for opencode serve/, "opencode in user-facing string"],
  [/\/Library\/Application Support\/opencode|\/etc\/opencode/, "managed config dir"],
  // user-facing CLI strings
  [/`opencode (auth|serve|run|mcp|import|exited)/, "opencode CLI reference in string"],
  [/Login with opencode|Starting opencode|Found opencode session|opencode version:/, "opencode brand in string"],
  [/Add servers with: opencode|resume an opencode|Configure via opencode/, "opencode brand in string"],
  [/opencode-debug|opencode-cli|opencode-clipboard/, "opencode internal id string"],
  // telemetry attribute keys
  [/"opencode\./, "telemetry attribute key opencode.*"],
  // outbound identity strings
  [/`opencode\//, "User-Agent prefix opencode/"],
  [/"User-Agent":\s*"opencode"/, 'User-Agent "opencode"'],
  [/sst-dev\.opencode/, "upstream VSCode extension id"],
  // plugin config file base name
  [/patchName\(kind: Kind\): "opencode"/, "plugin config kind opencode"],
  // TUI display: terminal title, wordmark, exit hint, prompts, issue link
  [/setTerminalTitle\("OpenCode"\)|`OC \| /, "terminal title OpenCode"],
  [/█▀▀█ █▀▀█ █▀▀█ █▀▀▄/, "opencode wordmark glyphs"],
  [/opencode -s \$\{/, "opencode resume hint"],
  [/(until|Tell|updated to) OpenCode|OpenCode includes free models|"OpenCode Default"/, "OpenCode in TUI string"],
  [/github\.com\/anomalyco\/opencode\/issues/, "upstream issue tracker URL"],
  [/<b>Open<\/b>/, "Open+Code split wordmark in sidebar"],
];

const bad = [];
const deferred = [];
// Phase 1 distributable core: rebrand must be complete here.
const CORE_PREFIXES = [
  "packages/opencode/",
  "packages/core/",
  "packages/ui/",
  "packages/sdk/",
  "packages/plugin/",
  "packages/script/",
];
// Phase 4 product surface: croakcode rebuilds these (desktop UI, marketing,
// stats, enterprise, GitHub Actions, infra, docs) and deliberately does NOT
// own the upstream service endpoints they reference (e.g. api.opencode.ai
// GitHub-App exchange, changelog/brand/legal/favicon, deployment domains).
// Rewriting those non-owned URLs to croakcode.ai would create dead links, so
// they are documented as DEFERRED instead of rewritten. Phase 2 core must not
// leak into these prefixes; anything outside CORE + PHASE4 fails closed below.
const PHASE4_PREFIXES = [
  ".opencode/",
  "github/",
  "infra/",
  "packages/app/",
  "packages/desktop/",
  "packages/docs/",
  "packages/enterprise/",
  "packages/slack/",
  "packages/stats/",
  "script/",
  "sdks/",
];
const isCore = (rel) => CORE_PREFIXES.some((p) => rel.startsWith(p));
const isPhase4 = (rel) => PHASE4_PREFIXES.some((p) => rel.startsWith(p));

for (const file of await walk(root)) {
  if (ALLOW.has(path.basename(file))) continue;
  const rel = path.relative(root, file).split(path.sep).join("/");
  if (ALLOW_PATHS.has(rel)) continue;
  const body = await readFile(file, "utf8").catch(() => "");
  const lines = body.split("\n");
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 주석 줄은 허용(상표 미사용은 식별자/배포물 기준).
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    for (const [re, label] of FORBIDDEN) {
      // 내부 워크스페이스 패키지 이름은 workspace:* 때문에 유지한다.
      if (label === 'package name "opencode"' && ALLOW_PKG_NAMES.has(rel)) continue;
      if (re.test(line)) found.push(`${file}:${i + 1} [${label}]`);
    }
  }
  if (!found.length) continue;
  // fail-closed: 코어도 Phase 4도 아닌 위치의 히트는 위반으로 처리한다.
  if (isCore(rel) || !isPhase4(rel)) bad.push(...found);
  else deferred.push(...found);
}

if (bad.length) {
  console.error("FAIL: disallowed upstream branding in core packages (or outside the Phase 4 allowlist)");
  for (const b of bad.slice(0, 50)) console.error(" - " + b);
  if (bad.length > 50) console.error(` ... and ${bad.length - 50} more`);
  process.exit(1);
}
if (deferred.length) {
  console.log(
    `DEFERRED: ${deferred.length} hits in Phase 4 product packages (app/desktop/docs/stats/enterprise/github/infra/sdks/script/.opencode) — not owned by croakcode core, deferred to Phase 4`,
  );
}
console.log("PASS: no disallowed upstream branding in core packages; Phase 4 deferred scope is explicit");
