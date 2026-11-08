import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

test("zen/console provider removal invariants hold", () => {
  const out = execFileSync("bash", [path.join(ROOT, "scripts/phase2-zen-check.sh")], { encoding: "utf8" });
  assert.match(out, /PASS: zen\/console provider fully removed/);
});

test("baseten enable_thinking branch is preserved", () => {
  // 검토 지적 P1 Task5: grep -v 'baseten' 마스킹으로 금지 히트를 가리지 않도록,
  // baseten 분기가 남아 있는지 별도로 확인한다.
  const out = execFileSync(
    "grep",
    ["-c", 'providerID === "baseten"', "upstream/packages/opencode/src/provider/transform.ts"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.ok(Number.parseInt(out.trim(), 10) >= 1, "baseten branch must remain");
});
