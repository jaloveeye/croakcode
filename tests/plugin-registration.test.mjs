import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

test("every server plugin file matches the auto-scan glob and exports default.id", async () => {
  const dir = new URL("../upstream/.croakcode/plugins/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => /\.(js|ts)$/.test(f));
  // auto-scan glob is {plugin,plugins}/*.{ts,js} — flat files only (lib/ is subdir, not matched)
  assert.ok(files.length >= 7, `expected >=7 plugin files, got ${files.length}`);
  for (const f of files) {
    const mod = await import(new URL(f, dir).href);
    assert.ok(mod.default?.id, `${f} has no default.id (path plugin requires id)`);
    assert.ok(mod.default?.server ?? mod.default?.tool, `${f} has neither server nor tool`);
  }
});

// 문자열 리터럴 내부의 //를 보존하는 JSONC 주석 제거기.
// 단순 replace(/\/\/.*$/gm,"")는 "https://croakcode.ai/..."를 훼손하므로 금지.
function stripJsonc(text) {
  let out = "", i = 0, inStr = false, esc = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length - 1 && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

test("croakcode.jsonc exists and parses as JSONC (string-safe comment stripping)", async () => {
  const raw = await readFile(new URL("../upstream/.croakcode/croakcode.jsonc", import.meta.url), "utf8");
  const parsed = JSON.parse(stripJsonc(raw));
  // The dev-safe agent references litellm-head/default, so the provider must stay defined.
  assert.ok(parsed.provider?.["litellm-head"], "croakcode.jsonc must keep the litellm-head provider");
  assert.ok(parsed.provider["litellm-head"].models?.default, "litellm-head must expose the default model");
  // Server plugins are auto-discovered from .croakcode/plugins; they must not be
  // listed in the `plugin` array as well (double load).
  assert.equal(parsed.plugin, undefined, "plugin array must stay absent (auto-scan covers .croakcode/plugins)");
});
