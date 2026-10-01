/* The ROYAL-to-Bot flow gate.  Tahir talks to ROYAL; ROYAL reaches ACE,
   GRACE, LEDGER, HOUSE and FORGE through the orchestrator, and each answer
   comes back to the same conversation.  No Bots-panel route is used: every
   turn here is royal.handle(), exactly what the main page sends.

   The bots are stand-ins at the far end of a real bridge: ROYAL's webhook
   call reaches them, and they answer the way a Grok Bot must, by posting a
   result event with the request_id and a structured envelope that repeats
   the handoff_id. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoyal } from "../core/royal.js";
import { MemoryStore } from "../core/store.js";
import { createBridge } from "../core/grokbot/bridge.js";
import { createHandler } from "../server/handler.js";
import { AgentOrchestrator, parseAgentRequest, chooseBackend, contextFor } from "../core/intelligence/orchestrator.js";
import { house, NOW } from "./fixtures.js";

const IDS = ["ace", "grace", "ledger", "house", "forge"];
const ROLES = { ace: "Sales and CRM", grace: "Client experience and production", ledger: "Finance", house: "Brand and marketing", forge: "Engineering and systems" };

/* Stand-in Grok Bots.  mode per bot: ok | slow | fail | prose | silent | ask_ledger | propose_send */
function standIns(modes = {}) {
  const calls = [];
  let bridge = null;
  const env = { GROKBOT_ENABLED: "true", GROKBOT_BOTS: IDS.join(",") };
  for (const id of IDS) { env["GROKBOT_" + id.toUpperCase() + "_WEBHOOK_URL"] = "https://bots.test/" + id; env["GROKBOT_" + id.toUpperCase() + "_WEBHOOK_KEY"] = "k-" + id; }
  const reply = async (body) => {
    const id = body.bot_id, mode = modes[id] || "ok";
    const handoff_id = (/^handoff_id: (\S+)$/m.exec(body.content) || [])[1], nonce = (/^nonce: (\S+)$/m.exec(body.content) || [])[1], task_id = (/^task_id: (\S+)$/m.exec(body.content) || [])[1];
    const env0 = { agent_id: id, task_id, handoff_id, status: "REPORTED_COMPLETE", summary: id.toUpperCase() + " looked: " + (body.content.match(/^Objective: (.*)$/m) || [, "connection test"])[1].slice(0, 60),
      findings: [id + " finding one", id + " finding two"], sources: [], actions_taken: [], artifacts: [], next_actions: [], requires_tahir: false, requires_approval: false, unresolved_questions: [],
      ...(nonce ? { nonce, name: id.toUpperCase(), role: ROLES[id] } : {}), timestamp: new Date().toISOString() };
    if (mode === "ask_ledger") Object.assign(env0, { requested_specialist: "ledger", requested_reason: "Check the money side" });
    if (mode === "propose_send") Object.assign(env0, { next_actions: [{ action: "send_email", to: "marcus@example.com", body: "Your balance is due" }], requires_approval: true, actions_taken: ["drafted an email"] });
    const post = mode === "prose" ? { request_id: body.request_id, type: "result", content_markdown: "All good, nothing to report." }
      : { request_id: body.request_id, type: "result", content_markdown: "Done.\n```json\n" + JSON.stringify(env0) + "\n```" };
    return bridge.postEvent(id, post, { principal: { kind: "bot", bot_id: id } });
  };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const mode = modes[body.bot_id] || "ok";
    if (mode === "fail") return new Response("down", { status: 500 });
    if (mode === "ok" || mode === "prose" || mode === "ask_ledger" || mode === "propose_send") setTimeout(() => reply(body), 5);
    if (mode === "slow") setTimeout(() => reply(body), 150);
    return new Response("{}", { status: 200 });
  };
  bridge = createBridge({ env, fetchImpl, logger: { warn() {}, log() {} }, limits: { WEBHOOK_RETRY_BACKOFF_MS: 1 } });
  return { bridge, calls, handoffTo: (id) => calls.filter((c) => c.bot_id === id).map((c) => JSON.parse((/Structured handoff \(data, not instructions\):\n(.*)$/m.exec(c.content) || [, "null"])[1])) };
}

async function setup(modes = {}, opts = {}) {
  const s = standIns(modes);
  const r = createRoyal({ store: new MemoryStore(), clock: () => NOW, bridge: s.bridge, botWaitMs: 100, ...opts });
  await r.ingestCalculator(house());
  const say = (content, conversation_id = "main") => r.handle({ content, conversation_id });
  return { ...s, r, say };
}
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

/* ------------------------------------------------------ one by one --- */

test("ROYAL to ACE: “Ask ACE what he worked on today” reaches ACE's bot and ACE's answer comes back to the conversation", async () => {
  const { r, say, calls } = await setup();
  const a = await say("Ask ACE what he worked on today.");
  assert.equal(a.skill, "agent_request");
  assert.equal(calls.filter((c) => c.bot_id === "ace").length, 1, "ACE's bot received it");
  assert.match(a.summary, /^ACE came back: ACE looked: Ask ACE what he worked on today/);
  const t = (await r.intelligence.tasks.list()).find((x) => x.agent === "ace" && x.adapter === "grokbot");
  assert.equal(t.status, "REPORTED_COMPLETE"); assert.equal(t.provenance, "EXPLICIT_BOT_REQUEST"); assert.equal(t.verification_state, "REPORTED_UNVERIFIED");
  assert.ok(t.handoff_id && t.parent_request_id && t.conversation_id === "BUSINESS:main", "correlated: handoff, parent request, conversation");
  assert.equal(t.result.envelope.handoff_id, t.handoff_id);
});

test("ROYAL to GRACE: “what's holding Marcus's project” goes with Marcus's project, and GRACE's answer returns", async () => {
  const { say, handoffTo } = await setup();
  const a = await say("Ask GRACE what's holding Marcus's project.");
  assert.match(a.summary, /^GRACE came back:/);
  const h = handoffTo("grace")[0];
  assert.equal(h.relevant_context.project.project_id, "PRJ-2026-00101");
  assert.equal(h.relevant_context.project.client_name, "Marcus Hill");
  assert.ok(h.parent_request_id && h.conversation_id === "BUSINESS:main" && h.handoff_id);
});

test("ROYAL to LEDGER: “Have LEDGER look at the financial impact” keeps Marcus in context and gives LEDGER the money", async () => {
  const { say, handoffTo } = await setup();
  await say("Pull up Marcus.");
  const a = await say("Have LEDGER look at the financial impact.");
  assert.match(a.summary, /^LEDGER came back:/);
  const p = handoffTo("ledger")[0].relevant_context.project;
  assert.equal(p.project_id, "PRJ-2026-00101"); assert.equal(p.outstanding, 13000); assert.equal(p.paid, 5000);
});

test("ROYAL to HOUSE: a content idea from the piece, with only what HOUSE needs (no balances, no client contact)", async () => {
  const { say, handoffTo } = await setup();
  await say("Pull up Marcus.");
  const a = await say("Have HOUSE build a content idea from it.");
  assert.match(a.summary, /^HOUSE came back:/);
  const p = handoffTo("house")[0].relevant_context.project;
  assert.equal(p.piece, "Cuban link chain");
  for (const k of ["outstanding", "paid", "value", "client_name", "client_id"]) assert.ok(!(k in p), "HOUSE was not given " + k);
});

test("ROYAL to FORGE: “why was ROYAL slow” goes with my own system state, and FORGE's answer returns", async () => {
  const { say, handoffTo } = await setup();
  const a = await say("Ask FORGE why ROYAL was slow earlier.");
  assert.match(a.summary, /^FORGE came back:/);
  const sys = handoffTo("forge")[0].relevant_context.system;
  assert.ok(Array.isArray(sys.diagnostics) && sys.diagnostics.some((d) => /^Project Calculator: /.test(d)), "FORGE got the diagnostics");
});

/* ------------------------------------------------------- together --- */

test("GRACE and LEDGER together: two hand-offs at once, one synthesized answer; LEDGER's bot failing doesn't take GRACE's answer down", async () => {
  const { r, say, calls } = await setup({ ledger: "fail" });
  const a = await say("Have GRACE and LEDGER look at Marcus together.");
  assert.notEqual(a.status, "FAILED");
  assert.match(a.summary, /GRACE came back:/);
  assert.match(a.summary, /I couldn't reach LEDGER's Grok Bot \(GROKBOT_HTTP_500\), so I checked that with LEDGER's finance logic: Marcus Hill owes \$13,000/);
  assert.ok(calls.some((c) => c.bot_id === "grace") && calls.some((c) => c.bot_id === "ledger"));
  const tasks = await r.intelligence.tasks.list();
  assert.equal(tasks.find((t) => t.agent === "ledger" && t.adapter === "grokbot").status, "FAILED");
  assert.equal(tasks.find((t) => t.agent === "grace" && t.adapter === "grokbot").status, "REPORTED_COMPLETE");
});

test("a reply that comes after the answer returns lands in the same conversation's inbox, and the page is told to listen", async () => {
  const { r, say } = await setup({ grace: "slow" });
  const a = await say("Ask GRACE what's holding Marcus's project.");
  assert.match(a.summary, /^I sent that to GRACE\. I'll bring the answer here when it comes\./);
  assert.deepEqual(a.pending.map((p) => p.agent), ["grace"]);
  await wait(250);
  const items = await r.orchestrator.readInbox("BUSINESS:main");
  assert.equal(items.length, 1);
  assert.match(items[0].result.summary, /^GRACE came back:/);
  assert.ok(items[0].result.presentation, "composed like any answer");
  assert.equal((await r.orchestrator.readInbox("BUSINESS:other")).length, 0, "and only there");
  assert.equal((await r.orchestrator.openFor("BUSINESS:main")).length, 0, "nothing left open");
});

test("the inbox is served to the signed-in owner, per conversation, Business only", async () => {
  const { r, say } = await setup({ grace: "slow" });
  await say("Ask GRACE what's holding Marcus's project.", "web-bus-1");
  const h = createHandler({ royal: r, auth: async (t) => (t === "owner" ? { id: "u", role: "owner" } : null) });
  const get = async (q) => (await h(new Request("https://royal.test/v1/inbox?" + q, { headers: { Authorization: "Bearer owner" } }))).json();
  assert.equal((await get("conversation_id=web-bus-1")).open, 1);
  await wait(250);
  const j = await get("conversation_id=web-bus-1");
  assert.equal(j.items.length, 1); assert.equal(j.open, 0);
  assert.equal((await get("conversation_id=web-bus-1&realm=PERSONAL")).items.length, 0);
});

test("a reply in prose only, or not naming the handoff, is kept as PARTIAL and said to be partial, never verified", async () => {
  const { r, say } = await setup({ ace: "prose" });
  const a = await say("Ask ACE what he worked on today.");
  assert.match(a.summary, /ACE came back: It replied in prose only: All good/);
  assert.match(a.summary, /wasn't in the required format/);
  const t = (await r.intelligence.tasks.list()).find((x) => x.agent === "ace" && x.adapter === "grokbot");
  assert.equal(t.status, "PARTIAL");
  const bots = (await r.orchestrator.backends("ace")).grokbot;
  assert.notEqual(bots.connection, "CONNECTED_VERIFIED", "prose does not verify the bot");
});

test("talk to each of the bots: my records first, then every bot, each answer on its own; a silent bot doesn't hold up the rest", async () => {
  const { r, say, calls } = await setup({ forge: "silent" });
  const a = await say("Talk to each of the Bots and tell me what they worked on today.");
  assert.match(a.summary, /^I checked today's record for all five\./);
  for (const id of ["ace", "grace", "ledger", "house"]) assert.match(a.summary, new RegExp(id.toUpperCase() + " came back:"));
  assert.match(a.summary, /I sent that to FORGE\. I'll bring the answer here when it comes\./);
  assert.equal(new Set(calls.map((c) => c.bot_id)).size, 5, "all five bots were contacted");
  const hs = calls.map((c) => /^handoff_id: (\S+)$/m.exec(c.content)[1]);
  assert.equal(new Set(hs).size, 5, "five separate handoffs");
  const day = await r.ledger.day("ace", (await import("../core/agent_ledger.js")).dayOf(NOW));
  assert.equal(day.bot.sent, 1); assert.equal(day.bot.returned, 1);
});

/* ----------------------------------------------------- authority --- */

test("a bot proposing to send an email gets nothing sent and no approval created by its say-so; its report is not verified", async () => {
  const { r, say } = await setup({ ace: "propose_send" });
  await say("Pull up Marcus.");
  const before = (await r.decisions.list()).length;
  const a = await say("Have ACE handle the client side.");
  assert.match(a.summary, /ACE came back:/);
  assert.match(a.summary, /ACE reports 1 action taken; that's its report, not verified\./);
  assert.match(a.summary, /ACE proposes: send_email\. Nothing has been done\./);
  assert.match(a.summary, /It says this needs your approval\. Nothing has been done/);
  assert.equal((await r.decisions.list()).length, before, "no decision from a bot's say-so");
  const log = await r.audit.developerLog({ limit: 500 });
  assert.ok(!log.some((e) => e.tool === "send_email" || e.tool === "send_client_message"), "no send tool was called");
  assert.ok(log.some((e) => e.action === "TOOL_CALLED" && e.tool === "delegate_to_bot"), "the hand-off itself went through the permission gate");
  assert.ok(log.some((e) => e.action === "AGENT_RESULT_RECEIVED"), "the answer is audited");
});

test("a specialist may ask for another through ROYAL; ROYAL decides, within the hop limit and never in a cycle", async () => {
  const { r, say, calls } = await setup({ grace: "ask_ledger" });
  const a = await say("Ask GRACE what's holding Marcus's project.");
  assert.match(a.summary, /GRACE asked for LEDGER's view, so I've asked LEDGER\./);
  await wait(120);
  /* ROYAL decided how: LEDGER's native finance logic is the fast path for a
     read of the House's money, and its answer comes to the conversation. */
  const items = await r.orchestrator.readInbox("BUSINESS:main");
  assert.ok(items.some((i) => /^I checked that with LEDGER's finance logic: Marcus Hill owes \$13,000/.test(i.result.summary)), JSON.stringify(items.map((i) => i.result.summary)));
  assert.ok(!calls.some((c) => c.bot_id === "ledger"), "no bot-to-bot message: GRACE named LEDGER, ROYAL chose the backend");
  /* bounds */
  const deep = await r.orchestrator.delegateToAgent({ agent_id: "ace", objective: "x", depth: 3 });
  assert.equal(deep.status, "REFUSED"); assert.equal(deep.reason, "DELEGATION_DEPTH");
  const loop = await r.orchestrator.delegateToAgent({ agent_id: "grace", objective: "x", depth: 1, chain: ["grace", "ledger"] });
  assert.equal(loop.status, "REFUSED"); assert.equal(loop.reason, "DELEGATION_CYCLE");
});

/* --------------------------------------------- connection and wording --- */

test("connection test through the orchestrator: the bot must return its name, role and the nonce; then, and only then, CONNECTED_VERIFIED", async () => {
  const { r, calls } = await setup();
  const h = createHandler({ royal: r, auth: async (t) => (t === "owner" ? { id: "u", role: "owner" } : null), bridge: r.orchestrator.bridge });
  for (const id of IDS) {
    const v = await (await h(new Request("https://royal.test/v1/bots/" + id + "/verify", { method: "POST", headers: { Authorization: "Bearer owner" } }))).json();
    assert.equal(v.ok, true, id);
  }
  await wait(60);
  for (const id of IDS) {
    const sent = calls.find((c) => c.bot_id === id && c.skill === "connection_check");
    assert.match(sent.content, /^nonce: n_[0-9a-f]+$/m);
    const b = (await r.orchestrator.backends(id)).grokbot;
    assert.equal(b.connection, "CONNECTED_VERIFIED", id); assert.ok(b.last_roundtrip_ms >= 0);
  }
  const checks = (await r.intelligence.tasks.list()).filter((t) => t.kind === "connection_check");
  assert.equal(checks.length, 5); assert.ok(checks.every((t) => t.status === "REPORTED_COMPLETE"));
  assert.equal((await r.orchestrator.readInbox("BUSINESS:main")).length, 0, "a connection test never lands in a conversation");
});

test("wording: I never say I asked a bot that wasn't reached, and never pass native logic off as the bot", async () => {
  const none = createRoyal({ store: new MemoryStore(), clock: () => NOW });
  await none.ingestCalculator(house());
  const a = await none.handle({ content: "Ask GRACE what's holding Marcus's project.", conversation_id: "c" });
  assert.match(a.summary, /^I checked that with GRACE's production logic: /);
  assert.doesNotMatch(a.summary, /sent that|came back/);
  const h = await none.handle({ content: "Have HOUSE build a content idea from it.", conversation_id: "c" });
  assert.match(h.summary, /HOUSE has no native runtime, and no Grok Bot is set up for HOUSE/);
});

test("the execution router: explicit requests go to a reachable bot; fast questions stay native; durable work goes to a verified bot", () => {
  const be = (bot) => ({ native: { available: true }, grokbot: bot });
  const ok = { configured: true, connection: "CONNECTED_VERIFIED", can_send: true, can_receive_tasks: true };
  const unverified = { configured: true, connection: "CONFIGURED_UNVERIFIED", can_send: true, can_receive_tasks: false };
  const broken = { configured: true, connection: "AUTH_FAILED", can_send: true, can_receive_tasks: false };
  assert.equal(chooseBackend({ agent: "ace", backends: be(unverified), explicit: true }).provenance, "EXPLICIT_BOT_REQUEST");
  assert.equal(chooseBackend({ agent: "ace", backends: be(ok), objective: "what's the pipeline?" }).provenance, "NATIVE_FAST_PATH");
  assert.equal(chooseBackend({ agent: "ace", backends: be(ok), objective: "research ten companies for corporate gifting" }).provenance, "DURABLE_BOT_ROUTE");
  assert.equal(chooseBackend({ agent: "ace", backends: be(unverified), objective: "research ten companies" }).provenance, "NATIVE_FAST_PATH", "durable work needs a verified bot");
  const f = chooseBackend({ agent: "ace", backends: be(broken), explicit: true });
  assert.equal(f.backend, "native"); assert.equal(f.provenance, "FALLBACK"); assert.match(f.why, /auth failed/);
  assert.equal(chooseBackend({ agent: "house", backends: { native: { available: false }, grokbot: { configured: false, connection: "NOT_CONFIGURED" } }, explicit: true }).backend, null);
});

test("who is asked: names, pairs and “each of the bots”; a client message still goes to the drafting skill", () => {
  assert.deepEqual(parseAgentRequest("Ask ACE what he worked on today.").agents, ["ace"]);
  assert.deepEqual(parseAgentRequest("Have GRACE and LEDGER look at Marcus together.").agents, ["grace", "ledger"]);
  assert.equal(parseAgentRequest("Talk to each of the Bots and tell me what they worked on today.").each, true);
  assert.deepEqual(parseAgentRequest("Get LEDGER's opinion on the deposit.").agents, ["ledger"]);
  assert.deepEqual(parseAgentRequest("Send this to FORGE.").agents, ["forge"]);
  assert.equal(parseAgentRequest("Have GRACE prepare an update for Marcus."), null);
  assert.equal(parseAgentRequest("Have LEDGER send him a reminder."), null);
  assert.equal(parseAgentRequest("What did every Bot do today?"), null, "a question about the record stays with the ledger");
  assert.equal(parseAgentRequest("Have house prices gone up?"), null, "house the word is not HOUSE the specialist");
  const c = contextFor("house", { project: { id: "P", name: "Ring", stage: "Production", client: { name: "X", id: "C" }, outstanding: 5, paid: 1, value: 6 } });
  assert.deepEqual(Object.keys(c.project).sort(), ["piece", "project_id", "stage", "target_date"]);
});

/* -------------------------------------------- the acceptance conversation --- */

test("acceptance: “ROYAL.” → each bot → “Ask GRACE more about the second thing” → LEDGER on what that means → ACE on the client side, all from the main conversation", async () => {
  const { r, say, calls, handoffTo } = await setup();
  const hi = await say("ROYAL.");
  assert.equal(hi.timing.model_calls, 0);
  const each = await say("Talk to each of the Bots and tell me what they worked on today.");
  assert.equal(new Set(calls.map((c) => c.bot_id)).size, 5);
  assert.match(each.summary, /GRACE came back:/);
  const second = (await say("Ask GRACE more about the second thing.")).summary;
  assert.match(second, /^GRACE came back:/);
  const gh = handoffTo("grace");
  assert.match(gh[gh.length - 1].relevant_context.referenced, /^GRACE came back:/, "the second thing was GRACE's line, and GRACE got it");
  const fin = await say("Have LEDGER tell me what that means financially.");
  assert.match(fin.summary, /^LEDGER came back:/);
  const lh = handoffTo("ledger");
  assert.match(lh[lh.length - 1].relevant_context.previous_answer, /GRACE came back:/, "LEDGER got what GRACE said");
  const client = await say("Have ACE handle the client side.");
  assert.match(client.summary, /^ACE came back:/);
  assert.equal((await r.decisions.list()).length, 0, "nothing consequential happened without approval");
  const tasks = (await r.intelligence.tasks.list()).filter((t) => t.adapter === "grokbot");
  assert.ok(tasks.every((t) => t.conversation_id === "BUSINESS:main" && t.handoff_id && t.parent_request_id));
});
