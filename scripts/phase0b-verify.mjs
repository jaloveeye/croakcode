#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const REQUIRED = [
  ["docs/superpowers/phase0/baseline-inventory.md", [/Plugin & invariant tests/, /Patch-added tests/, /adds NO tests/]],
  ["docs/superpowers/phase0/package-extraction.md", [/croak-auth/, /gate-identity/, /local-stability/, /secret-paths/, /stall-recovery/, /tool-policy/, /usage-meter/, /usage-panel/, /hwp-read/, /cache-hit/, /물리 추출 0개/]],
  ["docs/superpowers/phase0/sqlite-plan.md", [/journal_mode = WAL/, /busy_timeout = 5000/, /schema_version/, /2-phase commit/, /CREATE TABLE parts/]],
  ["docs/superpowers/phase0/equivalence-matrix.md", [/Required features/, /0002/, /0003/, /0004/, /0005/, /0006/, /0007/, /0008/, /local-stability/, /cache-hit/, /dev-safe/]],
  ["docs/superpowers/phase0/phase0-gate.md", [/Phase 0 Decision Gate/, /required feature list/]],
];

const failures = [];
for (const [file, patterns] of REQUIRED) {
  let body;
  try {
    body = await readFile(file, "utf8");
  } catch {
    failures.push(`${file}: MISSING`);
    continue;
  }
  for (const re of patterns) {
    if (!re.test(body)) failures.push(`${file}: missing pattern ${re}`);
  }
}

if (failures.length) {
  console.error("FAIL");
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log("PASS: all phase 0b artifacts present and complete");
