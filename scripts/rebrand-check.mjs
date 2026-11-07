#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.argv[2] ?? "upstream";
// 저작권/라이선스 고지 파일은 "opencode"/"anomalyco" 표기가 허용된다.
const ALLOW = new Set(["NOTICE", "LICENSE", "README.md", "UPSTREAM"]);
// fork 운영 도구(설치 보조 스크립트)는 대상 리포 경로/브랜치를 참조하므로 예외.
const ALLOW_PATHS = new Set(["patches/install-korean-ime-fix.sh"]);

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
];

const bad = [];
for (const file of await walk(root)) {
  if (ALLOW.has(path.basename(file))) continue;
  const rel = path.relative(root, file).split(path.sep).join("/");
  if (ALLOW_PATHS.has(rel)) continue;
  const body = await readFile(file, "utf8").catch(() => "");
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 주석 줄은 허용(상표 미사용은 식별자/배포물 기준).
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    for (const [re, label] of FORBIDDEN) {
      if (re.test(line)) bad.push(`${file}:${i + 1} [${label}]`);
    }
  }
}

if (bad.length) {
  console.error("FAIL: disallowed upstream branding");
  for (const b of bad.slice(0, 50)) console.error(" - " + b);
  process.exit(1);
}
console.log("PASS: no disallowed upstream branding outside NOTICE/attribution");
