import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// JSONC는 주석을 허용하므로 정식 파서 없이도 최소 검증이 가능하도록
// 주석 제거는 문자열 리터럴을 건드리지 않는 방식이어야 한다 (아래 helper).
function stripJsonc(text) {
  let out = "", i = 0, inStr = false, esc = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length - 1 && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

test("croakcode.jsonc defines provider litellm-head with a baseURL", async () => {
  const raw = await readFile(new URL("../upstream/.croakcode/croakcode.jsonc", import.meta.url), "utf8");
  const cfg = JSON.parse(stripJsonc(raw));
  const p = cfg.provider?.["litellm-head"];
  assert.ok(p, "provider.litellm-head missing");
  assert.equal(p.npm, "@ai-sdk/openai-compatible");
  assert.ok(p.options?.baseURL, "options.baseURL required");
  assert.ok(p.models && Object.keys(p.models).length > 0, "at least one model needed (qwen3.8-27b-nvfp4)");
  assert.ok(p.models["qwen3.8-27b-nvfp4"], "qwen3.8-27b-nvfp4 model missing");
});
