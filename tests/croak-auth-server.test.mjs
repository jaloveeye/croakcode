import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CROAK_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "croak-authsrv-"));
process.env.CROAK_PROVIDERS = "litellm-head,other";
process.env.CROAK_AUTH_URL = "https://gate.example";
process.env.CROAKCODE_CLIENT_VERSION = "1.2.3";

const S = await import("../upstream/.croakcode/plugins/lib/croak-auth-session.js");
const serverModule = await import("../upstream/.croakcode/plugins/croak-auth-server.js");
const plugin = serverModule.default;
const { shouldAttachToken } = serverModule;

test("plugin exports id and server", async () => {
  assert.equal(plugin.id, "croak-auth");
  const hooks = await plugin.server();
  assert.equal(typeof hooks["chat.headers"], "function");
});

test("not logged in => no Authorization", async () => {
  const hooks = await plugin.server();
  const out = { headers: { "x-existing": "1" } };
  await hooks["chat.headers"](
    { model: { providerID: "litellm-head" }, provider: { id: "litellm-head", options: { baseURL: "https://gate.example" } } },
    out,
  );
  assert.equal(out.headers.Authorization, undefined);
  assert.equal(out.headers["x-existing"], "1");
});

test("logged in + configured provider + gate-origin baseURL + gate mode => Authorization set", async () => {
  const hooks = await plugin.server();
  S.save({ access_token: "a", refresh_token: "r", access_expires_at: new Date(Date.now() + 3600e3).toISOString(), session_expires_at: new Date(Date.now() + 86400e3).toISOString(), user: {}, auth_url: "https://gate.example" });
  const out = { headers: {} };
  await hooks["chat.headers"](
    { model: { providerID: "litellm-head" }, provider: { id: "litellm-head", options: { baseURL: "https://gate.example/v1" } }, connection: { mode: "gate" } },
    out,
  );
  assert.equal(out.headers.Authorization, "Bearer a");
  assert.equal(out.headers["x-croak-client-version"], "1.2.3");
});

// === 보호 헤더 계약 (3중 조건) — 하나라도 어긋나면 토큰을 내보내지 않는다 ===
test("unconfigured provider => no Authorization even with token", async () => {
  const hooks = await plugin.server();
  S.save({ access_token: "a", refresh_token: "r", access_expires_at: new Date(Date.now() + 3600e3).toISOString(), session_expires_at: new Date(Date.now() + 86400e3).toISOString(), user: {}, auth_url: "https://gate.example" });
  const out = { headers: {} };
  await hooks["chat.headers"]({ model: { providerID: "other-provider" }, provider: { id: "other-provider", options: { baseURL: "https://gate.example" } }, connection: { mode: "gate" } }, out);
  assert.equal(out.headers.Authorization, undefined);
  assert.equal(out.headers["x-croak-client-version"], undefined);
});

test("provider baseURL origin != gate URL origin => no Authorization (token never leaks)", async () => {
  const hooks = await plugin.server();
  S.save({ access_token: "a", refresh_token: "r", access_expires_at: new Date(Date.now() + 3600e3).toISOString(), session_expires_at: new Date(Date.now() + 86400e3).toISOString(), user: {}, auth_url: "https://gate.example" });
  const out = { headers: {} };
  await hooks["chat.headers"]({ model: { providerID: "litellm-head" }, provider: { id: "litellm-head", options: { baseURL: "https://evil.example/v1" } }, connection: { mode: "gate" } }, out);
  assert.equal(out.headers.Authorization, undefined);
});

test("direct mode => no Authorization (gate token not needed/forbidden)", async () => {
  const hooks = await plugin.server();
  S.save({ access_token: "a", refresh_token: "r", access_expires_at: new Date(Date.now() + 3600e3).toISOString(), session_expires_at: new Date(Date.now() + 86400e3).toISOString(), user: {}, auth_url: "https://gate.example" });
  const out = { headers: {} };
  await hooks["chat.headers"]({ model: { providerID: "litellm-head" }, provider: { id: "litellm-head", options: { baseURL: "https://gate.example/v1" } }, connection: { mode: "direct" } }, out);
  assert.equal(out.headers.Authorization, undefined);
});

// === 로그인 서버 주소는 환경 변수로만 받는다 (소스에 인프라 주소 금지) ===
test("CROAK_AUTH_URL unset => no Authorization, login refuses with a clear error", async () => {
  const saved = process.env.CROAK_AUTH_URL;
  delete process.env.CROAK_AUTH_URL;
  try {
    assert.equal(S.authUrl(), undefined);
    assert.throws(() => S.requireAuthUrl(), (e) => e.code === "not_configured");
    assert.throws(() => S.loginUrl("c"), (e) => e.code === "not_configured");
    const hooks = await plugin.server();
    S.save({ access_token: "a", refresh_token: "r", access_expires_at: new Date(Date.now() + 3600e3).toISOString(), session_expires_at: new Date(Date.now() + 86400e3).toISOString(), user: {}, auth_url: "https://gate.example" });
    const out = { headers: {} };
    await hooks["chat.headers"]({ model: { providerID: "litellm-head" }, provider: { id: "litellm-head", options: { baseURL: "https://gate.example/v1" } }, connection: { mode: "gate" } }, out);
    assert.equal(out.headers.Authorization, undefined);
  } finally {
    process.env.CROAK_AUTH_URL = saved;
  }
});

test("unparsable gate URL and baseURL never compare equal", () => {
  const saved = process.env.CROAK_AUTH_URL;
  process.env.CROAK_AUTH_URL = "not a url";
  try {
    assert.equal(
      shouldAttachToken({ model: { providerID: "litellm-head" }, provider: { id: "litellm-head", options: { baseURL: "also not a url" } }, connection: { mode: "gate" } }),
      false,
    );
  } finally {
    process.env.CROAK_AUTH_URL = saved;
  }
});

test("plugin sources hardcode no login server address", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../upstream/.croakcode/plugins/lib/croak-auth-session.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /https?:\/\/\d{1,3}(\.\d{1,3}){3}/, "no literal IP URL in source");
  assert.doesNotMatch(src, /env\("CROAK_AUTH_URL",/, "CROAK_AUTH_URL must not have a fallback");
});
