#!/usr/bin/env node
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const REF = process.env.CROAKCODE_REF || "/Users/herace/workspace/ideas/codefrog-opencode";
const OUT = "docs/superpowers/phase0/baseline-inventory.md";

async function walk(dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "work") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, acc);
    else if (/\.test\.(mjs|ts|tsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const pluginTests = (await walk(path.join(REF, "plugins"))).sort();
const patchDir = path.join(REF, "opencode", "patches");
const patchAdded = [];
for (const file of (await readdir(patchDir)).sort()) {
  if (!file.endsWith(".patch")) continue;
  const body = await readFile(path.join(patchDir, file), "utf8");
  const hits = [...body.matchAll(/^\+\+\+ b\/(.*\.test\.(?:ts|tsx|mjs))$/gm)].map((m) => m[1]);
  patchAdded.push({ file, tests: [...new Set(hits)] });
}

const lines = [
  "# Baseline Test Inventory (Phase 0a)",
  "",
  `Reference repo: \`${REF}\``,
  `Plugin/invariant test files: ${pluginTests.length}`,
  "",
  "## Plugin & invariant tests (run with node --test / bun test)",
  "",
  ...pluginTests.map((p) => `- \`${path.relative(REF, p)}\``),
  "",
  "## Patch-added tests (per patch file)",
  "",
  ...patchAdded.map((p) =>
    p.tests.length
      ? `- \`${p.file}\`: ${p.tests.map((t) => `\`${t}\``).join(", ")}`
      : `- \`${p.file}\`: (adds NO tests — must be covered by a new Phase 2/3 test)`,
  ),
  "",
];
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, lines.join("\n"), "utf8");
console.log(`wrote ${OUT}: ${pluginTests.length} plugin tests, ${patchAdded.length} patches scanned`);
