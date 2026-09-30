import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler, supabaseAuth, fromEnv } from "../server/handler.js";
import { createRoyal } from "../core/royal.js";
import { MemoryStore } from "../core/store.js";
import { GrokProvider } from "../core/providers/grok.js";
import { house } from "./fixtures.js";

const USERS = { "t-owner": { id: "u-tahir", role: "owner" }, "t-staff": { id: "u-staff", role: "none" }, "t-member": { id: "u-tori", role: "member" } };
function app(extra = {}) {
  const royal = createRoyal({ store: new MemoryStore(), provider: new GrokProvider({ apiKey: "xai-SECRETSECRETSECRET1234", model: "grok-test", fetchImpl: async () => ({ ok: false, status: 500 }) }) });
  const handler = createHandler({ royal, auth: async (t) => USERS[t] || null, allowedOrigins: ["https://royal-t-9e9.pages.dev"], ...extra });
  const call = (method, path, { token = "t-owner", body, origin, raw } = {}) => handler(new Request("https://royal.test" + path, {
    method, headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...(origin ? { Origin: origin } : {}), "Content-Type": "application/json" },
    body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined }));
  return { royal, call };
}

test("health is public and says nothing else", async () => {
  const r = await app().call("GET", "/v1/health", { token: null });
  assert.equal(r.status, 200); assert.deepEqual(Object.keys(await r.json()).sort(), ["ok", "service", "version"]);
});
test("every other route needs a signed-in owner", async () => {
  const { call } = app();
  assert.equal((await call("GET", "/v1/status", { token: null })).status, 401);
  assert.equal((await call("GET", "/v1/status", { token: "forged" })).status, 401);
  assert.equal((await call("GET", "/v1/decisions", { token: "t-staff" })).status, 403);
  assert.equal((await call("POST", "/v1/command", { token: "t-staff", body: { content: "What needs me?" } })).status, 403);
  assert.equal((await call("POST", "/v1/ingest/calculator", { token: "t-staff", body: { snapshot: house() } })).status, 403);
});
test("an identity outage refuses rather than lets anyone in", async () => {
  const royal = createRoyal({ store: new MemoryStore() });
  const h = createHandler({ royal, auth: async () => { throw new Error("down"); } });
  const r = await h(new Request("https://royal.test/v1/status", { headers: { Authorization: "Bearer x" } }));
  assert.equal(r.status, 503);
});
test("ingest then ask, end to end", async () => {
  const { call } = app();
  const i = await call("POST", "/v1/ingest/calculator", { body: { snapshot: house() } });
  assert.equal(i.status, 200);
  const r = await (await call("POST", "/v1/command", { body: { content: "Who owes us money?" } })).json();
  assert.equal(r.ok, true); assert.equal(r.result.skill, "who_owes_us"); assert.ok(r.result.findings.length > 0);
});
test("an invalid snapshot is refused with reasons", async () => {
  const { call } = app();
  const r = await call("POST", "/v1/ingest/calculator", { body: { snapshot: { contract: "nope" } } });
  assert.equal(r.status, 422); assert.ok((await r.json()).errors.length > 0);
});
test("malformed and oversized bodies are refused", async () => {
  const { call } = app();
  assert.equal((await call("POST", "/v1/command", { raw: "{not json" })).status, 400);
  assert.equal((await call("POST", "/v1/command", { raw: JSON.stringify({ content: "x".repeat(6 * 1024 * 1024) }) })).status, 413);
});
test("decisions resolve through the API as the signed-in owner", async () => {
  const { call, royal } = app();
  const { decision } = await royal.decisions.create({ type: "GENERAL", title: "Approve the thing", requested_by_agent: "royal" });
  const r = await (await call("POST", "/v1/decisions/" + decision.id + "/resolve", { body: { resolution: "REJECT" } })).json();
  assert.equal(r.decision.status, "REJECTED"); assert.equal(r.decision.resolved_by, "u-tahir");
  const again = await call("POST", "/v1/decisions/" + decision.id + "/resolve", { body: { resolution: "APPROVE" } });
  assert.equal(again.status, 409); assert.equal((await again.json()).failed_because, "ALREADY_REJECTED");
});
test("CORS is granted only to allowed origins", async () => {
  const { call } = app();
  const ok = await call("GET", "/v1/status", { origin: "https://royal-t-9e9.pages.dev" });
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://royal-t-9e9.pages.dev");
  const bad = await call("GET", "/v1/status", { origin: "https://evil.example" });
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
});
test("no response ever carries the provider key", async () => {
  const { call } = app();
  await call("POST", "/v1/ingest/calculator", { body: { snapshot: house() } });
  for (const [m, p, b] of [["GET", "/v1/status"], ["GET", "/v1/agents"], ["POST", "/v1/command", { content: "Is the calculator connected?" }],
    ["POST", "/v1/command", { content: "What would a wise jeweller do this quarter?" }], ["GET", "/v1/developer/log"], ["GET", "/v1/activity"]]) {
    const t = await (await call(m, p, { body: b })).text();
    assert.ok(!/SECRETSECRET/.test(t), p + " leaked the key");
  }
});
test("supabase auth maps only listed ids to owner", async () => {
  const fetchImpl = async (u, o) => ({ ok: true, status: 200, json: async () => ({ id: o.headers.Authorization === "Bearer a" ? "u-tahir" : "u-other" }) });
  const auth = supabaseAuth({ url: "https://x.supabase.co", anonKey: "anon", ownerIds: ["u-tahir"], fetchImpl });
  assert.equal((await auth("a")).role, "owner"); assert.equal((await auth("b")).role, "none");
  const down = supabaseAuth({ url: "https://x.supabase.co", anonKey: "anon", fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(() => down("a"));
});
test("the development token is refused in production", async () => {
  await assert.rejects(() => fromEnv({ ROYAL_DEV_OWNER_TOKEN: "x", ROYAL_ENV: "production" }, { store: new MemoryStore() }), /must not be set in production/);
});

test("a house member may send calculator state and nothing else", async () => {
  const { call } = app();
  assert.equal((await call("POST", "/v1/ingest/calculator", { token: "t-member", body: { snapshot: house() } })).status, 200);
  assert.equal((await call("POST", "/v1/command", { token: "t-member", body: { content: "Who owes us money?" } })).status, 403);
  assert.equal((await call("GET", "/v1/decisions", { token: "t-member" })).status, 403);
  assert.equal((await call("GET", "/v1/activity", { token: "t-member" })).status, 403);
});
test("the file store is written owner-readable only", async () => {
  const { fileStore } = await import("../core/store.js");
  const { statSync, rmSync } = await import("node:fs");
  const path = "/tmp/royal-store-test-" + process.pid + ".json";
  const s = await fileStore(path);
  await s.put("tasks", "t1", { a: 1 }, null);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const again = await fileStore(path);
  assert.equal((await again.get("tasks", "t1")).data.a, 1, "survives a restart");
  rmSync(path);
});

/* ------------------------------------------------ ROYAL's own passcode -- */
import { passcodeAuth } from "../server/passcode.js";
const PASS = "correct horse battery", SECRET = "s".repeat(40);
function passApp(clock) {
  const royal = createRoyal({ store: new MemoryStore() });
  const passcode = passcodeAuth({ passcode: PASS, secret: SECRET, clock });
  const handler = createHandler({ royal, auth: async () => null, passcode });
  const call = (m, p, { token, body, ip = "1.2.3.4" } = {}) => handler(new Request("https://royal.test" + p, { method: m,
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip, ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined }));
  return { call, royal };
}
test("the right passcode signs in; the session opens ROYAL with no email and no Supabase", async () => {
  const { call } = passApp();
  const r = await (await call("POST", "/v1/login", { body: { passcode: PASS } })).json();
  assert.equal(r.ok, true); assert.match(r.token, /^rs1\./);
  const st = await call("GET", "/v1/status", { token: r.token });
  assert.equal(st.status, 200);
  assert.equal((await call("POST", "/v1/command", { token: r.token, body: { content: "What needs me?" } })).status, 200);
});
test("a wrong passcode is refused, and five wrong tries lock that address out", async () => {
  const { call } = passApp();
  for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/v1/login", { body: { passcode: "nope" + i } })).status, 401);
  assert.equal((await call("POST", "/v1/login", { body: { passcode: PASS } })).status, 429);
  assert.equal((await call("POST", "/v1/login", { body: { passcode: PASS }, ip: "5.6.7.8" })).status, 200, "another address is unaffected");
});
test("a tampered or expired session is refused", async () => {
  let now = Date.now();
  const { call } = passApp(() => now);
  const { token } = await (await call("POST", "/v1/login", { body: { passcode: PASS } })).json();
  const [, payload, sig] = token.split(".");
  const forged = "rs1." + Buffer.from(JSON.stringify({ sub: "owner", iat: 0, exp: 9e15 })).toString("base64url") + "." + sig;
  assert.equal((await call("GET", "/v1/status", { token: forged })).status, 401);
  assert.equal((await call("GET", "/v1/status", { token: "rs1." + payload + ".AAAA" })).status, 401);
  now += 31 * 86400000;
  assert.equal((await call("GET", "/v1/status", { token })).status, 401, "expired after 30 days");
});
test("without a configured passcode, login says so and no session can be forged", async () => {
  const royal = createRoyal({ store: new MemoryStore() });
  const passcode = passcodeAuth({ passcode: "short", secret: "x" });
  const h = createHandler({ royal, auth: async () => null, passcode });
  const r = await h(new Request("https://royal.test/v1/login", { method: "POST", body: JSON.stringify({ passcode: "short" }) }));
  assert.equal(r.status, 503);
  const m = await (await h(new Request("https://royal.test/v1/login-methods"))).json();
  assert.equal(m.passcode, false);
});


/* ----------------------------------------------------------------- Grok -- */
test("Grok: retries without optional settings, reports xAI's reason, never leaks the key", async () => {
  const calls = [];
  const fetchImpl = async (url, o) => {
    const b = JSON.parse(o.body); calls.push(b);
    if (b.max_tokens !== undefined) return { ok: false, status: 400, json: async () => ({ error: { message: "max_tokens not supported" } }) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "READY" } }] }) };
  };
  const g = new GrokProvider({ apiKey: "xai-KEYKEYKEYKEYKEYKEY99", model: "grok-4.7", fetchImpl });
  const t = await g.test();
  assert.equal(t.ok, true); assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.temperature === undefined && c.response_format === undefined));
  const bad = new GrokProvider({ apiKey: "xai-KEYKEYKEYKEYKEYKEY99", model: "grok-nope", fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ error: { message: "The model grok-nope does not exist" } }) }) });
  const b = await bad.test();
  assert.equal(b.ok, false); assert.match(b.detail, /does not exist/);
  assert.equal(bad.status().status, "DEGRADED");
  assert.ok(!/KEYKEY/.test(JSON.stringify([t, b, g, bad, g.status(), bad.status()])));
});
test("the Test Grok endpoint is owner-only and says plainly when Grok is not set up", async () => {
  const { call } = app();
  assert.equal((await call("POST", "/v1/provider/test", { token: "t-staff" })).status, 403);
  const royal = createRoyal({ store: new MemoryStore() });
  const h = createHandler({ royal, auth: async () => ({ id: "u", role: "owner" }) });
  const r = await (await h(new Request("https://royal.test/v1/provider/test", { method: "POST", headers: { Authorization: "Bearer x" } }))).json();
  assert.equal(r.ok, false); assert.equal(r.failed_because, "PROVIDER_NOT_CONNECTED");
});
