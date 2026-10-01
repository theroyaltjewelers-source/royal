/* Phase 1 regression tests: the route contract, the bot state contract the
   page reads, and the defects this pass fixed.  Each test names the defect. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHandler, allowedMethods, routeOf } from "../server/handler.js";
import { createRoyal } from "../core/royal.js";
import { MemoryStore } from "../core/store.js";
import { canSendTo } from "../web/js/bots.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const USERS = { "t-owner": { id: "u-tahir", role: "owner" } };
function app(extra = {}) {
  const royal = createRoyal({ store: new MemoryStore() });
  const lines = [];
  const handler = createHandler({ royal, auth: async (t) => USERS[t] || null, log: (l) => lines.push(l), staticFiles: async (p) => (p === "/" ? new Response("<html>", { headers: { "Content-Type": "text/html" } }) : null), ...extra });
  const call = (method, path, { token = "t-owner", body } = {}) => handler(new Request("https://royal.test" + path, {
    method, headers: { ...(token ? { Authorization: "Bearer " + token } : {}), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }));
  return { royal, call, lines };
}

/* ------------------------------------------------------- route contract --- */

/* Every call the page makes, read from the page's own source.  The path
   argument is rebuilt with each concatenated expression standing for an id. */
function expand(src, start) {
  /* string pieces joined by +; any non-string piece is an id */
  let out = "", depth = 0, i = start, inExpr = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (!depth && c === '"') { const j = src.indexOf('"', i + 1); out += src.slice(i + 1, j); i = j; inExpr = false; continue; }
    if (c === "(") { depth++; continue; }
    if (c === ")") { if (!depth) break; depth--; continue; }
    if (!depth && c === ",") break;
    if (!depth && /[A-Za-z_]/.test(c) && !inExpr) { out += "ace"; inExpr = true; }
    if (!depth && c === "+") inExpr = false;
  }
  return out.split("?")[0];
}
async function frontendCalls() {
  const calls = [];
  const scan = (file, src, re, mIdx) => { for (const m of src.matchAll(re)) calls.push({ file, method: m[1] || "GET", path: expand(src, m.index + m[0].length) }); };
  for (const f of (await readdir(join(ROOT, "web", "js"))).filter((x) => x.endsWith(".js"))) {
    const src = await readFile(join(ROOT, "web", "js", f), "utf8");
    scan(f, src, /api\(\s*"(GET|POST|DELETE)",\s*/g);
    for (const m of src.matchAll(/fetch\(\(CFG\.API \|\| ""\) \+ /g)) {
      const tail = src.slice(m.index, m.index + 300), mm = /method: "(POST|DELETE)"/.exec(tail);
      if (src[m.index + m[0].length] !== '"') continue;   /* the api() wrapper itself */
      calls.push({ file: f, method: mm ? mm[1] : "GET", path: expand(src, m.index + m[0].length) });
    }
  }
  const embed = await readFile(join(ROOT, "web", "royal-embed.js"), "utf8");
  scan("royal-embed.js", embed, /call\("(GET|POST)",\s*/g);
  return calls;
}

test("every API call the page makes has a route that accepts its method (no 404 or 405 from normal use)", async () => {
  const calls = await frontendCalls();
  assert.ok(calls.length >= 20, "found the page's calls: " + calls.length);
  for (const c of calls) {
    const allow = allowedMethods(c.path);
    assert.ok(allow, c.file + ": " + c.method + " " + c.path + " has no route");
    assert.ok(allow.split(", ").indexOf(c.method) >= 0, c.file + ": " + c.method + " " + c.path + " is not accepted (" + allow + ")");
  }
});

test("a known route asked with the wrong method is a 405 with Allow, not a 404", async () => {
  const { call } = app();
  const g = await call("GET", "/v1/command");
  assert.equal(g.status, 405); assert.equal(g.headers.get("allow"), "POST");
  const v = await call("GET", "/v1/bots/ace/verify");
  assert.equal(v.status, 405);
  const t = await call("PUT", "/v1/bots/ace/token");
  assert.equal(t.status, 405); assert.equal(t.headers.get("allow"), "POST, DELETE");
  assert.equal((await call("GET", "/v1/no-such-thing")).status, 404, "an unknown route is still a 404");
  assert.equal((await call("POST", "/")).status, 405, "the page is GET only");
});

test("HEAD is answered like GET with no body (probes and link previews used to get 404)", async () => {
  const { call } = app();
  const h = await call("HEAD", "/v1/health", { token: null });
  assert.equal(h.status, 200); assert.equal(await h.text(), "");
  const p = await call("HEAD", "/", { token: null });
  assert.equal(p.status, 200); assert.equal(await p.text(), "");
});

test("each API request is logged once, folded, with its status and error code, and never a token, body or query", async () => {
  const { call, lines } = app();
  await call("POST", "/v1/command", { body: { content: "secret words about Marcus" } });
  await call("GET", "/v1/knowledge/search?q=" + encodeURIComponent("private question"));
  await call("GET", "/v1/bots/ace/requests/11111111-1111-4111-8111-111111111111");
  await call("GET", "/v1/status", { token: "forged-token-value" });
  await call("GET", "/v1/health", { token: null });
  const text = JSON.stringify(lines);
  for (const leak of ["secret words", "private question", "forged-token-value", "t-owner", "Marcus"]) assert.ok(!text.includes(leak), "logged " + leak);
  assert.ok(!lines.some((l) => l.route === "/v1/health"), "a passing health check is not logged");
  const unauth = lines.find((l) => l.status === 401);
  assert.equal(unauth.error, "AUTH_INVALID"); assert.equal(unauth.route, "/v1/status");
  assert.ok(lines.some((l) => l.route === "/v1/bots/:bot/requests/:uuid"));
  assert.ok(lines.every((l) => l.request_id && typeof l.ms === "number"));
  assert.equal(routeOf("/v1/decisions/dec_abc/resolve"), "/v1/decisions/:id/resolve");
});

test("liveness depends on nothing: health answers with no provider, store or bridge configured", async () => {
  const { call } = app();
  const r = await call("GET", "/v1/health", { token: null });
  assert.equal(r.status, 200); assert.equal((await r.json()).ok, true);
});

/* ------------------------------------------------------ bot state contract --- */

test("the Bots panel decides Send from can_send, never from a status string", () => {
  assert.equal(canSendTo({ can_send: true, connection_state: "CONFIGURED_UNVERIFIED" }), true, "a configured bot may be messaged (that is how it gets verified)");
  assert.equal(canSendTo({ status: "CONNECTED" }), false, "the old status field means nothing to the page");
  assert.equal(canSendTo({ can_send: false, connection_state: "NOT_CONFIGURED" }), false);
  assert.equal(canSendTo(null), false);
});

test("no code reads a bot's old status === \"CONNECTED\"", async () => {
  const files = ["web/js/bots.js", "core/intelligence/agents.js", "core/intelligence/index.js", "core/royal.js", "core/agent_ledger.js", "core/grokbot/bridge.js"];
  for (const f of files) {
    const src = await readFile(join(ROOT, f), "utf8");
    assert.ok(!/\b(bot|b|st)\.status === "CONNECTED"/.test(src), f);
  }
});

/* -------------------------------------------------------- agent tasks --- */

import { SPECIALISTS } from "../realms/business/royal-t/specialists.js";
import { routeAgents, AgentTasks, NATIVE_RING } from "../core/intelligence/agents.js";
import { createBridge } from "../core/grokbot/bridge.js";
import { house, NOW } from "./fixtures.js";

async function houseRoyal(opts = {}) {
  const r = createRoyal({ store: new MemoryStore(), clock: () => NOW, ...opts });
  await r.ingestCalculator(house());
  return r;
}

test("a native specialist run is an AgentTask too: adapter native, VERIFIED_COMPLETE when I ran and validated it", async () => {
  const r = await houseRoyal();
  await r.handle({ content: "What needs me?", conversation_id: "c1" });
  const tasks = await r.intelligence.tasks.list();
  const native = tasks.filter((t) => t.adapter === "native");
  assert.ok(native.length >= 2, "one task per specialist consulted: " + native.length);
  assert.ok(native.every((t) => t.status === "VERIFIED_COMPLETE" && t.verification_state === "VERIFIED_INTERNAL" && t.history.length === 3 && t.run_id));
  assert.ok(native.every((t) => t.history.map((h) => h.status).join(">") === "ASSIGNED>IN_PROGRESS>VERIFIED_COMPLETE"));
});

test("a native run that times out is TIMED_OUT with AGENT_TIMEOUT, never USER_CANCELLED", async () => {
  const saved = SPECIALISTS.grace;
  SPECIALISTS.grace = () => new Promise(() => {});
  try {
    const r = await houseRoyal({ delegationTimeoutMs: 40 });
    await r.handle({ content: "What needs me?", conversation_id: "c1" });
    const g = (await r.intelligence.tasks.list()).find((t) => t.agent === "grace");
    assert.equal(g.status, "TIMED_OUT"); assert.equal(g.fail_reason, "AGENT_TIMEOUT");
  } finally { SPECIALISTS.grace = saved; }
});

test("/v1/agents reports current work from records: a run in flight is the current task, a finished one is the last task", async () => {
  const saved = SPECIALISTS.grace;
  let release; const gate = new Promise((ok) => { release = ok; });
  SPECIALISTS.grace = async (ctx) => { await gate; return saved(ctx); };
  try {
    const r = await houseRoyal({ delegationTimeoutMs: 5000 });
    const h = createHandler({ royal: r, auth: async (t) => USERS[t] || null });
    const get = async () => (await (await h(new Request("https://royal.test/v1/agents", { headers: { Authorization: "Bearer t-owner" } }))).json()).agents.find((a) => a.id === "grace");
    const turn = r.handle({ content: "What needs me?", conversation_id: "c1" });
    await new Promise((ok) => setTimeout(ok, 30));
    const busy = await get();
    assert.ok(busy.current_task, "GRACE is busy while her run is in flight");
    assert.equal(busy.current_task.adapter, "native"); assert.equal(busy.current_task.status, "IN_PROGRESS");
    release(); await turn;
    const done = await get();
    assert.equal(done.current_task, null);
    assert.equal(done.last_task.status, "VERIFIED_COMPLETE");
  } finally { SPECIALISTS.grace = saved; }
});

test("native task records stay bounded: a ring per agent, the ledger keeps the counts", async () => {
  const r = await houseRoyal();
  for (let i = 0; i < NATIVE_RING + 6; i++) await r.handle({ content: "What needs me?", conversation_id: "c" + i });
  const per = {};
  for (const t of await r.intelligence.tasks.list()) if (t.adapter === "native") per[t.agent] = (per[t.agent] || 0) + 1;
  assert.ok(Object.values(per).every((n) => n <= NATIVE_RING), JSON.stringify(per));
});

test("routing provenance: only a name Tahir said is his choice; a rule's or the model's pick is the system's", () => {
  const registry = { get: (id) => ({ id, name: id.toUpperCase(), status: "ACTIVE", capabilities: ["outreach"] }), specialists: () => [{ id: "ace", status: "ACTIVE", capabilities: ["outreach"] }] };
  const said = routeAgents({ intent: "outreach_draft", entities: { agent: "ace" } }, "Have ACE write him", { registry })[0];
  assert.equal(said.provenance, "EXPLICIT_USER_SELECTION");
  const filled = routeAgents({ intent: "outreach_draft", entities: { agent: "ace" } }, "Write them something", { registry })[0];
  assert.equal(filled.provenance, "CAPABILITY_ROUTE"); assert.notEqual(filled.reason, "named by Tahir");
  const cap = routeAgents({ intent: "outreach_draft", entities: {} }, "Write them something", { registry })[0];
  assert.equal(cap.provenance, "CAPABILITY_ROUTE"); assert.equal(cap.adapter, "native");
});

test("a Grok Bot task reaches WAITING when its bot says it is blocked, and REPORTED_COMPLETE (not verified) when it says done", async () => {
  const bridge = createBridge({ env: { GROKBOT_ENABLED: "true", GROKBOT_GRACE_WEBHOOK_URL: "https://hook.test/g", GROKBOT_GRACE_WEBHOOK_KEY: "k" },
    fetchImpl: async () => new Response("ok"), logger: { warn() {} } });
  const tasks = new AgentTasks({ store: new MemoryStore(), clock: () => NOW, bridge });
  const t = await tasks.create({ agent: "grace", adapter: "grokbot", objective: "Chase the setter" });
  const sent = await bridge.sendMessage("grace", { content: "Chase the setter" }, {});
  await tasks.update(t.id, { request_id: sent.body.request_id, status: "IN_PROGRESS" });
  await bridge.postEvent("grace", { request_id: sent.body.request_id, type: "progress", status: "blocked", content_markdown: "Waiting on the setter." });
  assert.equal((await tasks.list()).find((x) => x.id === t.id).status, "WAITING");
  await bridge.postEvent("grace", { request_id: sent.body.request_id, type: "result", content_markdown: "Done." });
  assert.equal((await tasks.list()).find((x) => x.id === t.id).status, "REPORTED_COMPLETE");
});

test("every task status in the enum is reachable by code", async () => {
  const { TASK_STATUS } = await import("../core/enums.js");
  const src = (await readFile(join(ROOT, "core/intelligence/agents.js"), "utf8"));
  for (const s of Object.keys(TASK_STATUS)) assert.ok(new RegExp("TS\\." + s + "\\b").test(src), s + " is never set");
});

/* --------------------------------------------------- conversation flow --- */

import { GrokProvider } from "../core/providers/grok.js";

function modelRoyal() {
  const prompts = [];
  const fetchImpl = async (url, init) => {
    const b = JSON.parse(init.body); prompts.push(JSON.stringify(b));
    const text = JSON.stringify({ answer: "It pushes $13,000 of receivables further out.", needs_outside_world: false, based_on: ["p0"], unknowns: [], proposed_actions: [] });
    return new Response(JSON.stringify({ choices: [{ message: { content: text } }], output: [{ type: "message", content: [{ type: "output_text", text }] }] }), { status: 200 });
  };
  const r = createRoyal({ store: new MemoryStore(), clock: () => NOW, provider: new GrokProvider({ apiKey: "xai-SECRETSECRETSECRET1234", model: "grok-4.3", fetchImpl }) });
  return { r, prompts };
}

test("a project answer names the piece and answers the question asked (it used to say only “Needs you: …”)", async () => {
  const r = await houseRoyal();
  const ask = async (q) => (await r.handle({ content: q, conversation_id: "c1" })).summary;
  assert.match(await ask("Pull up Marcus."), /^Marcus Hill's Cuban link chain\. It's in production, target 2026-09-20\. \$13,000 still owed\./);
  assert.match(await ask("What stage is it in?"), /^Marcus Hill's Cuban link chain\. It's in production/);
  assert.match(await ask("Why hasn't it moved?"), /not fully funded|Waiting on/);
  assert.match(await ask("What happened with Marcus?"), /^Marcus Hill's Cuban link chain/);
});

test("follow-ups about the record under discussion stay with the House and the model is given that record (they used to go to world knowledge)", async () => {
  const { r, prompts } = modelRoyal();
  await r.ingestCalculator(house());
  await r.handle({ content: "Pull up Marcus.", conversation_id: "c1" });
  for (const q of ["What's the financial impact?", "Does it affect Saturday?", "What would you do?"]) {
    prompts.length = 0;
    const a = await r.handle({ content: q, conversation_id: "c1" });
    assert.equal(a.skill, "open_question", q + " -> " + a.skill);
    assert.ok(prompts.some((p) => /Under discussion: Marcus Hill's Cuban link chain \(PRJ-2026-00101\)/.test(p)), q + ": the model saw the record");
    assert.equal(a.timing.model_calls, 1, q + ": one call, no classifier in front");
  }
});

test("what happened today: payments, stage changes and my specialists' runs, from events and the ledger, with no model", async () => {
  const r = await houseRoyal();
  const s = house(); const p = s.projects.find((x) => x.id === "PRJ-2026-00101");
  p.paid += 2000; p.outstanding -= 2000; s.generated_at += 60000;
  await r.ingestCalculator(s);
  await r.handle({ content: "What needs me?", conversation_id: "c1" });
  const a = await r.handle({ content: "What happened today?", conversation_id: "c1" });
  assert.equal(a.skill, "daily_digest"); assert.equal(a.timing.model_calls, 0);
  assert.match(a.summary, /payment came in/); assert.match(a.summary, /My specialists ran \d+ times/);
});

test("why didn't GRACE finish: the recorded reason, from the ledger", async () => {
  const saved = SPECIALISTS.grace;
  SPECIALISTS.grace = () => new Promise(() => {});
  try {
    const r = await houseRoyal({ delegationTimeoutMs: 30 });
    await r.handle({ content: "What needs me?", conversation_id: "c1" });
    const a = await r.handle({ content: "Why didn't GRACE finish that?", conversation_id: "c1" });
    assert.match(a.summary, /GRACE on triage: it ran past its deadline/);
  } finally { SPECIALISTS.grace = saved; }
});

/* ---------------------------------------------------------------- voice --- */

import { RealtimeVoice } from "../web/js/realtime.js";

function liveVoice(ask = async () => ({ summary: "Done.", status: "OK" })) {
  const pushed = [], sent = [];
  const v = new RealtimeVoice({ api: async () => ({}), ask, onState() {}, onSaid() {}, onHeard() {} });
  v.ctx = {}; v.pb = { push: (f) => pushed.push(f), stop() {}, begin() {}, end() {} };
  v.ws = { readyState: 1, send: (x) => sent.push(JSON.parse(x)) };
  const ev = (o) => v._event(JSON.stringify(o));
  const pcm = Buffer.from(new Uint8Array(480)).toString("base64");
  return { v, pushed, sent, ev, pcm };
}

test("barge-in: audio still in flight from the interrupted reply is dropped, never played", async () => {
  const { v, pushed, sent, ev, pcm } = liveVoice();
  await ev({ type: "response.created", response: { id: "r1" } });
  await ev({ type: "response.output_audio.delta", response_id: "r1", delta: pcm });
  assert.equal(pushed.length, 1);
  await ev({ type: "input_audio_buffer.speech_started" });                          /* Tahir talks over me */
  assert.ok(sent.some((m) => m.type === "response.cancel"), "the provider is told to stop");
  await ev({ type: "response.output_audio.delta", response_id: "r1", delta: pcm });   /* late frames of r1 */
  await ev({ type: "response.output_audio.delta", response_id: "r1", delta: pcm });
  assert.equal(pushed.length, 1, "nothing old plays after the interruption");
  assert.equal(v.dropped, 2);
  await ev({ type: "response.created", response: { id: "r2" } });
  await ev({ type: "response.output_audio.delta", response_id: "r1", delta: pcm });   /* r1 straggler during r2 */
  await ev({ type: "response.output_audio.delta", response_id: "r2", delta: pcm });
  assert.equal(pushed.length, 2, "only the new reply plays");
});

test("barge-in during a check: the answer is handed back, but I don't speak it over Tahir's new turn", async () => {
  let release; const gate = new Promise((ok) => { release = ok; });
  const { v, sent, ev } = liveVoice(async () => { await gate; return { summary: "Marcus owes $13,000.", status: "OK" }; });
  const call = ev({ type: "response.function_call_arguments.done", name: "ask_royal", call_id: "c1", arguments: JSON.stringify({ request: "What does Marcus owe?" }) });
  await new Promise((ok) => setTimeout(ok, 5));
  await ev({ type: "input_audio_buffer.speech_started" });
  release(); await call;
  assert.ok(sent.some((m) => m.type === "conversation.item.create" && m.item.call_id === "c1"), "the tool call is closed");
  assert.ok(!sent.some((m) => m.type === "response.create"), "no stale spoken answer");
  /* without an interruption the answer is spoken */
  const b = liveVoice();
  await b.ev({ type: "response.function_call_arguments.done", name: "ask_royal", call_id: "c2", arguments: JSON.stringify({ request: "Hi" }) });
  assert.ok(b.sent.some((m) => m.type === "response.create"));
});

/* ------------------------------------------------------------- security --- */

import { passcodeAuth } from "../server/passcode.js";
import { clientAddress } from "../server/handler.js";

test("sign-in rate limit: a forged X-Forwarded-For doesn't reset it, and guessing from many addresses is limited too", async () => {
  const req = (xff) => new Request("https://royal.test/v1/login", { method: "POST", headers: { "x-forwarded-for": xff } });
  assert.equal(clientAddress(req("1.2.3.4, 10.0.0.9")), "10.0.0.9", "the proxy's entry, not the client's");
  assert.equal(clientAddress(req("9.9.9.9, 10.0.0.9")), "10.0.0.9");
  const auth = passcodeAuth({ passcode: "correct horse battery", secret: "s".repeat(40) });
  for (let i = 0; i < 5; i++) await auth.login("wrong", "10.0.0.9");
  assert.equal((await auth.login("correct horse battery", "10.0.0.9")).status, 429, "one address: 5 tries");
  const many = passcodeAuth({ passcode: "correct horse battery", secret: "s".repeat(40) });
  for (let i = 0; i < 30; i++) await many.login("wrong", "addr" + i);
  assert.equal((await many.login("wrong", "fresh-address")).status, 429, "30 wrong from anywhere pauses sign-in");
});
