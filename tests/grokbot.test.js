/* The Grok Bot bridge, end to end over real HTTP.

   Every test runs ROYAL's real handler behind the real node adapter, with
   fake bot webhooks that record what they receive.  The Postgres tests run
   when TEST_DATABASE_URL is set (they are skipped, and say so, otherwise). */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHandler } from "../server/handler.js";
import { nodeAdapter } from "../server/node-adapter.js";
import { passcodeAuth } from "../server/passcode.js";
import { createRoyal } from "../core/royal.js";
import { MemoryStore } from "../core/store.js";
import { createBridge, bridgeFromEnv } from "../core/grokbot/bridge.js";
import { MemoryBridgeStore } from "../core/grokbot/store.js";

const PASS = "test-passcode-123";
const SECRET = "0123456789abcdef0123456789abcdef-test";
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "migrations");
const BOTS = ["skill_library", "royal", "ace", "house", "grace", "me_bot", "grok_bot"];
const quiet = { log() {}, warn() {}, error() {} };

/* ---------------------------------------------------------- fixtures --- */

/* Fake Grok Bot webhooks: one path per bot, every call recorded. */
async function webhooks() {
  const calls = [], fail = new Map();
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const bot = req.url.slice(1);
    calls.push({ bot, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") });
    const code = fail.get(bot) || 200;
    res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: code < 400 }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + srv.address().port;
  return { base, calls, fail, close: () => new Promise((r) => srv.close(r)) };
}

function botEnv(base, extra = {}) {
  const env = { GROKBOT_ENABLED: "true", GROKBOT_BOTS: BOTS.join(","), GROKBOT_ALLOW_INSECURE_WEBHOOKS: "true" };
  for (const b of BOTS) {
    const P = "GROKBOT_" + b.toUpperCase() + "_";
    env[P + "WEBHOOK_URL"] = base + "/" + b;
    env[P + "WEBHOOK_KEY"] = "whk-" + b + "-SECRET-KEY-do-not-leak";
  }
  env.GROKBOT_ACE_KEY_HEADER = "X-Ace-Key";
  return { ...env, ...extra };
}

/* One ROYAL instance: real handler, real adapter, real port. */
async function instance(bridge, { royal } = {}) {
  royal = royal || createRoyal({ store: new MemoryStore() });
  const passcode = passcodeAuth({ passcode: PASS, secret: SECRET });
  const handler = createHandler({ royal, auth: async () => null, passcode, bridge, rateLimit: { perMinute: 10000 } });
  const srv = http.createServer(nodeAdapter(handler));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + srv.address().port;
  const login = await (await fetch(url + "/v1/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passcode: PASS }) })).json();
  const call = async (method, path, body, token = login.token) => {
    const r = await fetch(url + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch (_) { json = null; }
    return { status: r.status, json, text };
  };
  return { url, royal, bridge, owner: login.token, call,
    close: async () => { srv.closeAllConnections && srv.closeAllConnections(); await new Promise((r) => srv.close(r)); } };
}

/* Reads a Server-Sent Events stream until `until(events)` or a timeout. */
async function readSSE(url, path, token, { until = () => false, ms = 3000, lastEventId } = {}) {
  const ac = new AbortController();
  const events = []; let hello = null, status = 0;
  const timer = setTimeout(() => ac.abort(), ms);
  const ready = (async () => {
    const r = await fetch(url + path, { headers: { Authorization: "Bearer " + token, ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}) }, signal: ac.signal });
    status = r.status;
    if (r.status !== 200) return;
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += value; let cut;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, cut); buf = buf.slice(cut + 2);
        let ev = "message", data = "";
        for (const line of block.split("\n")) { if (line.startsWith("event: ")) ev = line.slice(7); else if (line.startsWith("data: ")) data += line.slice(6); }
        if (ev === "hello") hello = JSON.parse(data);
        if (ev === "bot_event") { events.push(JSON.parse(data)); if (until(events)) { ac.abort(); return; } }
      }
    }
  })().catch(() => {});
  return { events, get hello() { return hello; }, get status() { return status; }, done: ready.then(() => { clearTimeout(timer); }), stop: () => ac.abort() };
}
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------ memory suite --- */

let W, I;
before(async () => {
  W = await webhooks();
  I = await instance(createBridge({ env: botEnv(W.base), logger: quiet, limits: { WEBHOOK_RETRY_BACKOFF_MS: 5 } }));
});
after(async () => { await I.close(); await W.close(); });

async function tokenFor(inst, bot) {
  const r = await inst.call("POST", "/v1/bots/" + bot + "/token");
  assert.equal(r.status, 201, r.text);
  return r.json.token;
}

test("unauthenticated requests get 401", async () => {
  for (const [m, p] of [["GET", "/v1/bots"], ["POST", "/v1/bots/ace/message"], ["POST", "/v1/bots/ace/events"], ["GET", "/v1/bots/ace/feed"], ["GET", "/v1/bots/ace/stream"], ["GET", "/v1/feed/stream"], ["POST", "/v1/bots/ace/token"], ["POST", "/v1/integrations/grokbot/run"]]) {
    const r = await I.call(m, p, m === "POST" ? {} : undefined, null);
    assert.equal(r.status, 401, m + " " + p);
  }
  const bogus = await I.call("GET", "/v1/bots", undefined, "rbt_AAAAAAAAAAAA_" + "B".repeat(43));
  assert.equal(bogus.status, 401);
});

test("GET /v1/bots lists every bot with status and never a URL, key or header", async () => {
  const r = await I.call("GET", "/v1/bots");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.bots.map((b) => b.id).sort(), [...BOTS].sort());
  assert.ok(r.json.bots.every((b) => b.status === "CONNECTED"));
  for (const leak of ["whk-", "SECRET-KEY", W.base, "X-Ace-Key", "webhook_url", "\"url\"", "\"key\""]) assert.ok(!r.text.includes(leak), "leaked " + leak);
});

test("a bot token can only post its own events and read its own requests", async () => {
  const ace = await tokenFor(I, "ace");
  const denied = [["GET", "/v1/bots/ace/feed"], ["GET", "/v1/bots/ace/stream"], ["GET", "/v1/feed/stream"], ["GET", "/v1/bots"],
    ["POST", "/v1/bots/grace/events", { type: "message", content_markdown: "x" }], ["POST", "/v1/bots/ace/message", { content: "x" }],
    ["POST", "/v1/bots/ace/token"], ["DELETE", "/v1/bots/ace/token"], ["POST", "/v1/command", { content: "What needs me?" }],
    ["GET", "/v1/decisions"], ["GET", "/v1/status"], ["GET", "/v1/activity"], ["GET", "/v1/domains?realm=PERSONAL"], ["GET", "/v1/agents"],
    ["POST", "/v1/integrations/grokbot/run", { skill: "001" }], ["POST", "/v1/integrations/grokbot/result", { result_markdown: "x" }]];
  for (const [m, p, b] of denied) {
    const r = await I.call(m, p, b, ace);
    assert.equal(r.status, 403, m + " " + p + " gave " + r.status);
  }
  const own = await I.call("POST", "/v1/bots/ace/events", { type: "message", content_markdown: "Ace checking in." }, ace);
  assert.equal(own.status, 201, own.text);
});

test("the owner cannot post as a bot: events come only from the bot's own token", async () => {
  const r = await I.call("POST", "/v1/bots/ace/events", { type: "message", content_markdown: "pretending" });
  assert.equal(r.status, 403);
});

test("a mismatched body bot_id gets 400; another bot's request_id gets 403", async () => {
  const ace = await tokenFor(I, "ace");
  const mis = await I.call("POST", "/v1/bots/ace/events", { bot_id: "grace", type: "message", content_markdown: "x" }, ace);
  assert.equal(mis.status, 400); assert.equal(mis.json.error, "BOT_ID_MISMATCH");
  const g = await I.call("POST", "/v1/bots/grace/message", { content: "Grace, status?" });
  assert.equal(g.status, 200, g.text);
  const cross = await I.call("POST", "/v1/bots/ace/events", { request_id: g.json.request_id, type: "result", content_markdown: "hijack" }, ace);
  assert.equal(cross.status, 403); assert.equal(cross.json.error, "REQUEST_FORBIDDEN");
  const read = await I.call("GET", "/v1/bots/ace/requests/" + g.json.request_id, undefined, ace);
  assert.equal(read.status, 404);
  const readOther = await I.call("GET", "/v1/bots/grace/requests/" + g.json.request_id, undefined, ace);
  assert.equal(readOther.status, 403);
});

test("a message to Ace reaches only Ace's webhook, with Ace's header and the full payload", async () => {
  W.calls.length = 0;
  const r = await I.call("POST", "/v1/bots/ace/message", { content: "Ace, who is ready to buy?", skill: "pipeline", conversation_id: "conv-1" });
  assert.equal(r.status, 200, r.text);
  assert.equal(W.calls.length, 1);
  const c = W.calls[0];
  assert.equal(c.bot, "ace");
  assert.equal(c.headers["x-ace-key"], "whk-ace-SECRET-KEY-do-not-leak");
  assert.equal(c.headers.authorization, undefined);
  assert.deepEqual(Object.keys(c.body).sort(), ["bot_id", "content", "conversation_id", "realm", "reply_endpoint", "request", "request_id", "requested_by", "sent_at", "skill"]);
  assert.equal(c.body.bot_id, "ace"); assert.equal(c.body.realm, "BUSINESS"); assert.equal(c.body.request, c.body.content);
  assert.equal(c.body.reply_endpoint, "/v1/bots/ace/events"); assert.equal(c.body.request_id, r.json.request_id); assert.equal(c.body.conversation_id, "conv-1");
  const g = await I.call("POST", "/v1/bots/grace/message", { content: "hello" });
  assert.equal(g.status, 200);
  assert.equal(W.calls[1].bot, "grace"); assert.equal(W.calls[1].headers.authorization, "Bearer whk-grace-SECRET-KEY-do-not-leak");
  const req = await I.call("GET", "/v1/bots/ace/requests/" + r.json.request_id);
  assert.equal(req.json.request.status, "delivered");
});

test("request status follows the bot's events", async () => {
  const ace = await tokenFor(I, "ace");
  const r = await I.call("POST", "/v1/bots/ace/message", { content: "Draft the follow-ups." });
  const id = r.json.request_id;
  await I.call("POST", "/v1/bots/ace/events", { request_id: id, type: "progress", content_markdown: "Working on it." }, ace);
  assert.equal((await I.call("GET", "/v1/bots/ace/requests/" + id, undefined, ace)).json.request.status, "in_progress");
  await I.call("POST", "/v1/bots/ace/events", { request_id: id, type: "result", content_markdown: "**Done.** Three drafts." }, ace);
  assert.equal((await I.call("GET", "/v1/bots/ace/requests/" + id)).json.request.status, "completed");
  const unknown = await I.call("POST", "/v1/bots/ace/events", { request_id: "00000000-0000-4000-8000-000000000000", type: "result", content_markdown: "x" }, ace);
  assert.equal(unknown.status, 404);
});

test("Ace's stream carries only Ace's events; the combined stream labels every event", async () => {
  const ace = await tokenFor(I, "ace"), grace = await tokenFor(I, "grace");
  const aceS = await readSSE(I.url, "/v1/bots/ace/stream", I.owner, { until: (e) => e.some((x) => x.content_markdown === "ace-2") });
  const all = await readSSE(I.url, "/v1/feed/stream", I.owner, { until: (e) => e.some((x) => x.content_markdown === "ace-2") });
  await tick(150);
  for (const [tok, bot, text] of [[ace, "ace", "ace-1"], [grace, "grace", "grace-1"], [ace, "ace", "ace-2"]])
    assert.equal((await I.call("POST", "/v1/bots/" + bot + "/events", { type: "message", content_markdown: text }, tok)).status, 201);
  await Promise.all([aceS.done, all.done]);
  assert.deepEqual(aceS.events.map((e) => e.content_markdown), ["ace-1", "ace-2"]);
  assert.ok(aceS.events.every((e) => e.bot_id === "ace"));
  assert.deepEqual(all.events.map((e) => e.bot_id + ":" + e.content_markdown), ["ace:ace-1", "grace:grace-1", "ace:ace-2"]);
});

test("resume replays only the events that bot's stream missed", async () => {
  const ace = await tokenFor(I, "ace"), grace = await tokenFor(I, "grace");
  const first = await I.call("POST", "/v1/bots/ace/events", { type: "message", content_markdown: "seen" }, ace);
  await I.call("POST", "/v1/bots/ace/events", { type: "message", content_markdown: "missed-1" }, ace);
  await I.call("POST", "/v1/bots/grace/events", { type: "message", content_markdown: "grace-missed" }, grace);
  await I.call("POST", "/v1/bots/ace/events", { type: "message", content_markdown: "missed-2" }, ace);
  const s = await readSSE(I.url, "/v1/bots/ace/stream", I.owner, { lastEventId: first.json.event_id, until: (e) => e.length >= 2, ms: 1500 });
  await s.done;
  assert.deepEqual(s.events.map((e) => e.content_markdown), ["missed-1", "missed-2"]);
  const q = await readSSE(I.url, "/v1/bots/ace/stream?since=" + first.json.event_id, I.owner, { until: (e) => e.length >= 2, ms: 1500 });
  await q.done;
  assert.deepEqual(q.events.map((e) => e.content_markdown), ["missed-1", "missed-2"]);
});

test("a webhook failure gives 502, records last_error, retries once, and leaks nothing", async () => {
  W.fail.set("house", 500); W.calls.length = 0;
  const r = await I.call("POST", "/v1/bots/house/message", { content: "House, the launch post?" });
  W.fail.delete("house");
  assert.equal(r.status, 502); assert.equal(r.json.error, "GROKBOT_HTTP_500");
  assert.equal(W.calls.filter((c) => c.bot === "house").length, 2, "one retry on a 5xx");
  for (const leak of ["whk-", "SECRET", W.base, "127.0.0.1"]) assert.ok(!r.text.includes(leak), "leaked " + leak);
  const list = await I.call("GET", "/v1/bots");
  const house = list.json.bots.find((b) => b.id === "house");
  assert.equal(house.last_error, "GROKBOT_HTTP_500");
  assert.ok(!list.text.includes("whk-"));
  const req = await I.call("GET", "/v1/bots/house/requests/" + r.json.request_id);
  assert.equal(req.json.request.status, "failed");
  W.fail.set("me_bot", 404); W.calls.length = 0;
  const four = await I.call("POST", "/v1/bots/me_bot/message", { content: "hi" });
  W.fail.delete("me_bot");
  assert.equal(four.status, 502); assert.equal(W.calls.length, 1, "no retry on a 4xx");
});

test("an unreachable webhook is a 502 with no address in it", async () => {
  const b = createBridge({ env: botEnv("http://127.0.0.1:9"), logger: quiet, limits: { WEBHOOK_RETRY_BACKOFF_MS: 5, WEBHOOK_TIMEOUT_MS: 2000 } });
  const r = await b.sendMessage("ace", { content: "hello" });
  assert.equal(r.status, 502); assert.equal(r.body.error, "GROKBOT_UNREACHABLE");
  assert.ok(!JSON.stringify(r.body).includes("127.0.0.1"));
});

test("rotating a token invalidates the old one; revoking leaves none", async () => {
  const t1 = await tokenFor(I, "grok_bot");
  assert.equal((await I.call("POST", "/v1/bots/grok_bot/events", { type: "message", content_markdown: "one" }, t1)).status, 201);
  const t2 = await tokenFor(I, "grok_bot");
  assert.notEqual(t1, t2);
  assert.equal((await I.call("POST", "/v1/bots/grok_bot/events", { type: "message", content_markdown: "old" }, t1)).status, 401);
  assert.equal((await I.call("POST", "/v1/bots/grok_bot/events", { type: "message", content_markdown: "new" }, t2)).status, 201);
  const del = await I.call("DELETE", "/v1/bots/grok_bot/token");
  assert.equal(del.status, 200); assert.equal(del.json.revoked, 1);
  assert.equal((await I.call("POST", "/v1/bots/grok_bot/events", { type: "message", content_markdown: "after" }, t2)).status, 401);
});

test("the v1 compatibility routes still work and map to skill_library", async () => {
  W.calls.length = 0;
  const run = await I.call("POST", "/v1/integrations/grokbot/run", { skill: "001", request: "morning briefing" });
  assert.equal(run.status, 200, run.text);
  assert.equal(W.calls[0].bot, "skill_library"); assert.equal(W.calls[0].body.skill, "001"); assert.equal(W.calls[0].body.request, "morning briefing");
  const sl = await tokenFor(I, "skill_library");
  const res = await I.call("POST", "/v1/integrations/grokbot/result", { request_id: run.json.request_id, skill: "001", status: "completed", result_markdown: "# Briefing\nAll clear." }, sl);
  assert.equal(res.status, 201, res.text);
  const got = await I.call("GET", "/v1/integrations/grokbot/result/" + run.json.request_id);
  assert.equal(got.status, 200);
  assert.equal(got.json.result_markdown, "# Briefing\nAll clear."); assert.equal(got.json.status, "completed"); assert.equal(got.json.source, "grokbot");
  const ace = await tokenFor(I, "ace");
  assert.equal((await I.call("POST", "/v1/integrations/grokbot/result", { result_markdown: "x" }, ace)).status, 403);
});

test("realms: Business-only bots never touch Personal; skill_library works in both", async () => {
  W.calls.length = 0;
  const p = await I.call("POST", "/v1/bots/ace/message", { content: "my calendar", realm: "PERSONAL" });
  assert.equal(p.status, 403); assert.equal(p.json.error, "REALM_FORBIDDEN");
  const pq = await I.call("POST", "/v1/bots/ace/message?realm=PERSONAL", { content: "my calendar" });
  assert.equal(pq.status, 403);
  assert.equal(W.calls.length, 0, "nothing reached the bot");

  const personal = await I.call("GET", "/v1/bots?realm=PERSONAL");
  assert.deepEqual(personal.json.bots.map((b) => b.id), ["skill_library"]);
  assert.equal((await I.call("GET", "/v1/bots/ace/feed?realm=PERSONAL")).status, 403);
  assert.equal((await I.call("GET", "/v1/bots/ace/stream?realm=PERSONAL")).status, 403);

  const ace = await tokenFor(I, "ace");
  const tag = await I.call("POST", "/v1/bots/ace/events", { type: "message", content_markdown: "sneak", realm: "PERSONAL" }, ace);
  assert.equal(tag.status, 403); assert.equal(tag.json.error, "REALM_FORBIDDEN");
  const plain = await I.call("POST", "/v1/bots/ace/events", { type: "message", content_markdown: "business as usual" }, ace);
  assert.equal(plain.json.realm, "BUSINESS");

  const sl = await tokenFor(I, "skill_library");
  const personalStream = await readSSE(I.url, "/v1/feed/stream?realm=PERSONAL", I.owner, { until: (e) => e.some((x) => x.content_markdown === "personal-result"), ms: 2500 });
  await tick(150);
  const m = await I.call("POST", "/v1/bots/skill_library/message", { content: "plan my week", realm: "PERSONAL" });
  assert.equal(m.status, 200, m.text);
  assert.equal(W.calls.at(-1).body.realm, "PERSONAL");
  await I.call("POST", "/v1/bots/ace/events", { type: "message", content_markdown: "ace-business-while-personal-open" }, ace);
  await I.call("POST", "/v1/bots/skill_library/events", { type: "message", content_markdown: "skill-library-business-while-personal-open" }, sl);
  await I.call("POST", "/v1/bots/skill_library/events", { request_id: m.json.request_id, type: "result", content_markdown: "personal-result" }, sl);
  await personalStream.done;
  assert.ok(personalStream.events.every((e) => e.realm === "PERSONAL" && e.bot_id === "skill_library"), JSON.stringify(personalStream.events));
  assert.ok(personalStream.events.some((e) => e.content_markdown === "personal-result"));

  const pf = await I.call("GET", "/v1/bots/skill_library/feed?realm=PERSONAL");
  const bf = await I.call("GET", "/v1/bots/skill_library/feed?realm=BUSINESS");
  assert.ok(pf.json.events.some((e) => e.content_markdown === "personal-result"));
  assert.ok(!bf.json.events.some((e) => e.content_markdown === "personal-result" || e.content_markdown === "plan my week"));
  const mismatch = await I.call("POST", "/v1/bots/skill_library/events", { request_id: m.json.request_id, type: "message", content_markdown: "x", realm: "BUSINESS" }, sl);
  assert.equal(mismatch.status, 400);
});

test("input is validated: unknown bots 404, sizes and types enforced", async () => {
  assert.equal((await I.call("POST", "/v1/bots/nobody/message", { content: "x" })).status, 404);
  assert.equal((await I.call("GET", "/v1/bots/nobody/feed")).status, 404);
  assert.equal((await I.call("POST", "/v1/bots/ace/message", { content: "" })).status, 400);
  assert.equal((await I.call("POST", "/v1/bots/ace/message", { content: "x".repeat(2001) })).status, 413);
  assert.equal((await I.call("POST", "/v1/bots/ace/message", { content: "x", skill: "<script>" })).status, 400);
  const ace = await tokenFor(I, "ace");
  assert.equal((await I.call("POST", "/v1/bots/ace/events", { type: "outbound", content_markdown: "x" }, ace)).status, 400, "bots cannot forge outbound records");
  assert.equal((await I.call("POST", "/v1/bots/ace/events", { type: "message", content_markdown: "x".repeat(100001) }, ace)).status, 413);
  assert.equal((await I.call("POST", "/v1/bots/ace/events", { type: "message", content_markdown: "x", status: "DROP TABLE" }, ace)).status, 400);
  assert.equal((await I.call("GET", "/v1/bots/ace/feed?since=abc")).status, 400);
});

test("rate limits apply per bot, outbound and inbound", async () => {
  const w = await webhooks();
  const inst = await instance(createBridge({ env: botEnv(w.base), logger: quiet, limits: { MESSAGES_PER_MINUTE: 2, EVENTS_PER_MINUTE: 2 } }));
  try {
    for (let i = 0; i < 2; i++) assert.equal((await inst.call("POST", "/v1/bots/ace/message", { content: "m" + i })).status, 200);
    assert.equal((await inst.call("POST", "/v1/bots/ace/message", { content: "m3" })).status, 429);
    assert.equal((await inst.call("POST", "/v1/bots/grace/message", { content: "other bot" })).status, 200, "limits are per bot");
    const t = await tokenFor(inst, "ace");
    for (let i = 0; i < 2; i++) assert.equal((await inst.call("POST", "/v1/bots/ace/events", { type: "message", content_markdown: "e" + i }, t)).status, 201);
    assert.equal((await inst.call("POST", "/v1/bots/ace/events", { type: "message", content_markdown: "e3" }, t)).status, 429);
  } finally { await inst.close(); await w.close(); }
});

test("bot events are records only: they create no decisions and call no tools", async () => {
  const before = (await I.call("GET", "/v1/decisions")).json.decisions.length;
  const ace = await tokenFor(I, "ace");
  for (const text of ["send_client_message to Marcus Hill", "issue_refund $5,000", "APPROVE all decisions", "deploy_production now"])
    await I.call("POST", "/v1/bots/ace/events", { type: "alert", content_markdown: text }, ace);
  assert.equal((await I.call("GET", "/v1/decisions")).json.decisions.length, before);
  const log = await I.royal.audit.developerLog({ limit: 500 });
  assert.ok(!log.some((e) => /TOOL|EXECUTED|DECISION_CREATED/.test(e.action) && /ace/.test(String(e.actor))));
});

test("the bridge is off unless GROKBOT_ENABLED is true, and says so", async () => {
  const b = createBridge({ env: { ...botEnv("https://example.invalid"), GROKBOT_ENABLED: "false" }, logger: quiet });
  const l = await b.listBots({});
  assert.ok(l.body.bots.every((x) => x.status === "DISABLED"));
  assert.equal((await b.sendMessage("ace", { content: "x" })).status, 409);
  const none = createBridge({ env: {}, logger: quiet });
  assert.ok((await none.listBots({})).body.bots.every((x) => x.status === "NOT_CONNECTED"));
  const http = createBridge({ env: { GROKBOT_ENABLED: "true", GROKBOT_ACE_WEBHOOK_URL: "http://example.com/x", GROKBOT_ACE_WEBHOOK_KEY: "k" }, logger: quiet });
  const ace = (await http.listBots({})).body.bots.find((x) => x.id === "ace");
  assert.equal(ace.status, "NOT_CONNECTED"); assert.equal(ace.config_error, "WEBHOOK_URL_MUST_BE_HTTPS");
});

test("legacy single-bot env still configures skill_library", async () => {
  const b = createBridge({ env: { GROKBOT_ENABLED: "true", GROKBOT_WEBHOOK_URL: "https://example.com/hook", GROKBOT_WEBHOOK_KEY: "k" }, logger: quiet });
  const l = (await b.listBots({ realm: "BUSINESS" })).body.bots;
  assert.equal(l.find((x) => x.id === "skill_library").status, "CONNECTED");
  assert.deepEqual(l.find((x) => x.id === "skill_library").realms, ["BUSINESS", "PERSONAL"]);
  assert.deepEqual(l.find((x) => x.id === "ace").realms, ["BUSINESS"]);
});

test("tokens are stored only as hashes", async () => {
  const store = new MemoryBridgeStore();
  const b = createBridge({ env: botEnv("https://example.com"), store, logger: quiet });
  const r = await b.issueToken("ace");
  assert.ok(!JSON.stringify(store.tokens).includes(r.body.token));
  assert.match(store.tokens[0].token_hash, /^[0-9a-f]{64}$/);
});

test("streams: unbuffered headers, heartbeat, a cap per bot, and cleanup on disconnect", async () => {
  const w = await webhooks();
  const inst = await instance(createBridge({ env: botEnv(w.base), logger: quiet, limits: { MAX_STREAMS_PER_SCOPE: 1, SSE_HEARTBEAT_MS: 50 } }));
  try {
    const ac = new AbortController();
    const r = await fetch(inst.url + "/v1/bots/ace/stream", { headers: { Authorization: "Bearer " + inst.owner }, signal: ac.signal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /^text\/event-stream/);
    assert.equal(r.headers.get("x-accel-buffering"), "no");
    assert.match(r.headers.get("cache-control"), /no-cache/);
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let text = ""; const t0 = Date.now();
    while (!/: ping/.test(text) && Date.now() - t0 < 2000) text += (await reader.read()).value || "";
    assert.match(text, /retry: \d+/); assert.match(text, /event: hello/); assert.match(text, /: ping/);
    assert.equal((await inst.call("GET", "/v1/bots/ace/stream")).status, 429, "one stream per bot in this test");
    assert.equal(inst.bridge.stats().total, 1);
    ac.abort();
    for (let i = 0; i < 40 && inst.bridge.stats().total; i++) await tick(25);
    assert.equal(inst.bridge.stats().total, 0, "the stream was released when the client left");
    const again = await readSSE(inst.url, "/v1/bots/ace/stream", inst.owner, { ms: 200 });
    await again.done; assert.equal(again.status, 200);
  } finally { await inst.close(); await w.close(); }
});

test("uploads are capped before sign-in is checked", async () => {
  const big = "x".repeat(6 * 1024 * 1024);
  const r = await fetch(I.url + "/v1/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: big }).catch((e) => ({ status: "reset:" + e.message }));
  assert.ok(r.status === 413 || String(r.status).startsWith("reset"), "got " + r.status);
  const alive = await I.call("GET", "/v1/bots");
  assert.equal(alive.status, 200, "the server is still up");
});

test("a switched-off bot's events are refused; the owner cannot post v1 results as the bot", async () => {
  const w = await webhooks();
  const inst = await instance(createBridge({ env: { ...botEnv(w.base), GROKBOT_ACE_ENABLED: "false" }, logger: quiet }));
  try {
    const t = await tokenFor(inst, "ace");
    const r = await inst.call("POST", "/v1/bots/ace/events", { type: "message", content_markdown: "x" }, t);
    assert.equal(r.status, 409); assert.equal(r.json.error, "BOT_DISABLED");
    assert.equal((await inst.call("POST", "/v1/integrations/grokbot/result", { result_markdown: "forged" })).status, 403);
    assert.equal((await inst.call("GET", "/v1/bots/grace/feed?since=99999999999999999999")).status, 400);
  } finally { await inst.close(); await w.close(); }
});

test("a gap too large to replay tells the client to reload instead of skipping events", async () => {
  const w = await webhooks();
  const inst = await instance(createBridge({ env: botEnv(w.base), logger: quiet, limits: { REPLAY_MAX: 3, REPLAY_PAGES: 2 } }));
  try {
    const t = await tokenFor(inst, "ace");
    for (let i = 1; i <= 5; i++) await inst.call("POST", "/v1/bots/ace/events", { type: "message", content_markdown: "e" + i }, t);
    const paged = await readSSE(inst.url, "/v1/bots/ace/stream?since=1", inst.owner, { until: (e) => e.length >= 4, ms: 1000 });
    await paged.done;
    assert.deepEqual(paged.events.map((e) => e.content_markdown), ["e2", "e3", "e4", "e5"], "two pages replay everything");
    for (let i = 6; i <= 9; i++) await inst.call("POST", "/v1/bots/ace/events", { type: "message", content_markdown: "e" + i }, t);
    const r = await fetch(inst.url + "/v1/bots/ace/stream?since=1", { headers: { Authorization: "Bearer " + inst.owner } });
    const text = await r.text();
    assert.match(text, /event: reset/);
    assert.ok(!/"e9"/.test(text), "nothing live is sent after a reset");
  } finally { await inst.close(); await w.close(); }
});

/* ---------------------------------------------------- Postgres suite --- */

const DB = process.env.TEST_DATABASE_URL;
const pgSkip = DB ? false : "set TEST_DATABASE_URL to run the Postgres tests";

async function resetDb() {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  await pool.query("DROP TABLE IF EXISTS grokbot_events, grokbot_requests, grokbot_bot_tokens, grokbot_bot_state, royal_migrations CASCADE");
  await pool.end();
}
const pgEnv = (base) => ({ ...botEnv(base), DATABASE_URL: DB, DATABASE_SSL: "false" });

test("Postgres: migrations apply once and the database enforces same-bot requests and one active token", { skip: pgSkip }, async () => {
  await resetDb();
  const b = await bridgeFromEnv(pgEnv("https://example.com"), { migrationsDir: MIGRATIONS, logger: quiet });
  const b2 = await bridgeFromEnv(pgEnv("https://example.com"), { migrationsDir: MIGRATIONS, logger: quiet });   /* second start: nothing to apply */
  const pg = (await import("pg")).default; const pool = new pg.Pool({ connectionString: DB });
  try {
    assert.deepEqual((await pool.query("SELECT name FROM royal_migrations ORDER BY name")).rows.map((r) => r.name), ["001_grokbot.sql", "002_royal_store.sql"]);
    await pool.query("INSERT INTO grokbot_requests (id, bot_id, realm, status) VALUES ('11111111-1111-4111-8111-111111111111', 'grace', 'BUSINESS', 'requested')");
    await assert.rejects(pool.query("INSERT INTO grokbot_events (bot_id, realm, request_id, type, content_markdown) VALUES ('ace', 'BUSINESS', '11111111-1111-4111-8111-111111111111', 'result', 'x')"), /grokbot_events_request_same_bot/);
    await pool.query("INSERT INTO grokbot_events (bot_id, realm, request_id, type, content_markdown) VALUES ('grace', 'BUSINESS', '11111111-1111-4111-8111-111111111111', 'result', 'x')");
    await assert.rejects(pool.query("INSERT INTO grokbot_events (bot_id, realm, request_id, type, content_markdown) VALUES ('grace', 'PERSONAL', '11111111-1111-4111-8111-111111111111', 'result', 'x')"), /grokbot_events_request_same_bot/, "an event's realm must match its request's");
    await assert.rejects(pool.query("INSERT INTO grokbot_events (bot_id, realm, type, content_markdown) VALUES ('ace', 'SIDEWAYS', 'message', 'x')"), /check/i);
    await pool.query("INSERT INTO grokbot_bot_tokens (id, bot_id, prefix, token_hash) VALUES ('22222222-2222-4222-8222-222222222222', 'ace', 'p1', repeat('a', 64))");
    await assert.rejects(pool.query("INSERT INTO grokbot_bot_tokens (id, bot_id, prefix, token_hash) VALUES ('33333333-3333-4333-8333-333333333333', 'ace', 'p2', repeat('b', 64))"), /one_active/);
  } finally { await pool.end(); await b.close(); await b2.close(); }
});

test("Postgres: events, requests and tokens survive a restart", { skip: pgSkip }, async () => {
  await resetDb();
  const w = await webhooks();
  let A = await instance(await bridgeFromEnv(pgEnv(w.base), { migrationsDir: MIGRATIONS, logger: quiet }));
  const tok = await tokenFor(A, "ace");
  const m = await A.call("POST", "/v1/bots/ace/message", { content: "Before the restart." });
  await A.call("POST", "/v1/bots/ace/events", { request_id: m.json.request_id, type: "result", content_markdown: "Answer before the restart." }, tok);
  await A.close(); await A.bridge.close();

  const B = await instance(await bridgeFromEnv(pgEnv(w.base), { migrationsDir: MIGRATIONS, logger: quiet }));
  try {
    const feed = await B.call("GET", "/v1/bots/ace/feed");
    assert.deepEqual(feed.json.events.map((e) => e.type + ":" + e.content_markdown), ["outbound:Before the restart.", "result:Answer before the restart."]);
    assert.equal((await B.call("GET", "/v1/bots/ace/requests/" + m.json.request_id)).json.request.status, "completed");
    assert.equal((await B.call("POST", "/v1/bots/ace/events", { type: "message", content_markdown: "still me" }, tok)).status, 201, "token survives");
    assert.equal((await B.call("GET", "/v1/bots/grace/feed")).json.events.length, 0);
    const list = await B.call("GET", "/v1/bots");
    assert.equal(list.json.storage, "DURABLE");
    assert.ok(list.json.bots.find((b) => b.id === "ace").last_seen);
  } finally { await B.close(); await B.bridge.close(); await w.close(); }
});

test("Postgres: LISTEN/NOTIFY fans out across two server instances, per bot", { skip: pgSkip }, async () => {
  await resetDb();
  const w = await webhooks();
  const A = await instance(await bridgeFromEnv(pgEnv(w.base), { migrationsDir: MIGRATIONS, logger: quiet }));
  const B = await instance(await bridgeFromEnv(pgEnv(w.base), { migrationsDir: MIGRATIONS, logger: quiet }));
  try {
    const ace = await tokenFor(A, "ace"), grace = await tokenFor(A, "grace");
    const onB = await readSSE(B.url, "/v1/bots/ace/stream", B.owner, { until: (e) => e.length >= 2, ms: 4000 });
    const graceOnB = await readSSE(B.url, "/v1/bots/grace/stream", B.owner, { until: (e) => e.length >= 1, ms: 4000 });
    const allOnB = await readSSE(B.url, "/v1/feed/stream", B.owner, { until: (e) => e.length >= 3, ms: 4000 });
    await tick(300);
    await A.call("POST", "/v1/bots/ace/events", { type: "progress", content_markdown: "from A, ace 1" }, ace);
    await A.call("POST", "/v1/bots/grace/events", { type: "message", content_markdown: "from A, grace" }, grace);
    await A.call("POST", "/v1/bots/ace/events", { type: "result", content_markdown: "from A, ace 2" }, ace);
    await Promise.all([onB.done, graceOnB.done, allOnB.done]);
    assert.deepEqual(onB.events.map((e) => e.content_markdown), ["from A, ace 1", "from A, ace 2"]);
    assert.deepEqual(graceOnB.events.map((e) => e.content_markdown), ["from A, grace"]);
    assert.deepEqual(allOnB.events.map((e) => e.bot_id), ["ace", "grace", "ace"]);
  } finally { await A.close(); await B.close(); await A.bridge.close(); await B.bridge.close(); await w.close(); }
});
