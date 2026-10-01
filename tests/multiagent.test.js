/* The multi-agent correction: "What did each Bot do today?" is answered from
   ROYAL's own records (it used to be sent to web research); one specialist
   failing or timing out never takes the others down; every cancellation has
   a reason, and a bare "stop" no longer cancels delegated work; the agent
   activity ledger counts every run, even when runs finish together. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoyal } from "../core/royal.js";
import { MemoryStore } from "../core/store.js";
import { GrokProvider } from "../core/providers/grok.js";
import { SPECIALISTS } from "../realms/business/royal-t/specialists.js";
import { AgentActivityLedger, dayOf } from "../core/agent_ledger.js";
import { AgentTasks } from "../core/intelligence/agents.js";
import { route } from "../core/router.js";
import { house, NOW } from "./fixtures.js";

const KEY = "xai-SECRETSECRETSECRET1234";
const ISO = new Date(NOW).toISOString();

function xai() {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }] }), { status: 200 }); };
  return { calls, provider: new GrokProvider({ apiKey: KEY, model: "grok-4.3", fetchImpl }) };
}
async function royalWith(opts = {}) {
  const r = createRoyal({ store: new MemoryStore(), clock: () => NOW, ...opts });
  await r.ingestCalculator(house());
  return r;
}
const ask = (r, content, conversation_id = "c1") => r.handle({ content, conversation_id });

/* A stand-in bridge: ACE's bot posted today, GRACE's feed cannot be read. */
function fakeBridge() {
  return {
    enabled: () => true,
    listBots: async () => ({ body: { ok: true, bots: [
      { id: "ace", name: "Ace", config_state: "CONFIGURED", connection: "CONNECTED_VERIFIED", can_send: true, can_receive_tasks: true, last_seen: ISO, last_verified_at: ISO },
      { id: "grace", name: "Grace", config_state: "CONFIGURED", connection: "CONFIGURED_UNVERIFIED", can_send: true, can_receive_tasks: false },
      { id: "house", name: "House", config_state: "CONFIGURED", connection: "FAILED", can_send: true, can_receive_tasks: false, last_error: "WEBHOOK_HTTP_500" }] } }),
    getFeed: async (id) => {
      if (id === "grace") throw new Error("feed unavailable");
      if (id === "ace") return { body: { ok: true, events: [
        { type: "outbound", content_markdown: "ROYAL task", created_at: ISO },
        { type: "result", content_markdown: "**Followed up** with three [qualified leads](http://x). Two replied.", created_at: ISO }] } };
      return { body: { ok: true, events: [] } };
    },
    getRequest: async () => ({ body: { ok: false } }),
    storage: () => "TEMPORARY",
  };
}

/* -------------------------------------------------- the original failure --- */

test("“Tell me what each Bot did for work today.” is answered from my records, not sent to web research", async () => {
  const x = xai();
  const r = await royalWith({ provider: x.provider });
  await ask(r, "What needs me?");                      /* real work for the specialists to have done */
  const a = await ask(r, "Tell me what each Bot did for work today.");
  assert.equal(a.skill, "agent_activity"); assert.notEqual(a.status, "FAILED");
  assert.equal(a.timing.model_calls, 0); assert.equal(x.calls.length, 0, "no web search, no model");
  for (const n of ["ACE", "GRACE", "LEDGER", "HOUSE", "FORGE"]) assert.match(a.summary, new RegExp("\\b" + n + "\\b"), n);
  assert.match(a.summary, /^I checked/);
  assert.match(a.summary, /triage/);
});

test("bot and team questions route to my records in all their phrasings, and nothing else does", () => {
  for (const q of ["Tell me what each Bot did for work today.", "What did the bots do today?", "What did ACE do today?", "What did each bot accomplish?",
    "What did my AI team work on?", "Show me agent activity", "what did grace get done", "What did HOUSE post today?"]) assert.equal(route(q).skill, "agent_activity", q);
  assert.equal(route("What are you working on?").skill, "active_work");
  assert.equal(route("Diagnose yourself").skill, "self_diagnostic");
  assert.equal(route("What systems are actually working?").skill, "self_diagnostic");
  for (const q of ["What did Marcus pay today?", "What did the House do today?", "Have ACE write him", "How is the house doing"]) assert.notEqual(route(q).skill, "agent_activity", q);
});

/* ---------------------------------------------------- fault isolation --- */

test("one specialist failing does not take the others down; the failure is reported with its reason", async () => {
  const saved = SPECIALISTS.forge;
  SPECIALISTS.forge = async () => { throw new Error("forge exploded"); };
  try {
    const r = await royalWith();
    const a = await ask(r, "What needs me?");
    assert.notEqual(a.status, "FAILED");
    assert.match(a.summary, /things? need/);
    const f = a.delegations.find((d) => d.agent === "forge");
    assert.equal(f.verified, false); assert.match(f.errors[0], /exploded/);
    assert.ok(a.delegations.filter((d) => d.agent !== "forge").every((d) => d.verified));
    const day = await r.ledger.day("forge", dayOf(NOW));
    assert.equal(day.failed, 1); assert.equal(day.recent[0].reason, "ERROR");
  } finally { SPECIALISTS.forge = saved; }
});

test("a specialist that never answers times out on its own deadline, recorded as TIMEOUT, and the answer still comes", async () => {
  const saved = SPECIALISTS.grace;
  SPECIALISTS.grace = () => new Promise(() => {});
  try {
    const r = await royalWith({ delegationTimeoutMs: 60 });
    const t0 = Date.now();
    const a = await ask(r, "What needs me?");
    assert.ok(Date.now() - t0 < 2000);
    assert.notEqual(a.status, "FAILED");
    assert.equal((await r.ledger.day("grace", dayOf(NOW))).timed_out, 1);
    const b = await ask(r, "What did GRACE do today?");
    assert.match(b.summary, /1 timed out/);
  } finally { SPECIALISTS.grace = saved; }
});

test("the daily review reads each agent on its own: a bot whose feed can't be read is named, the rest are reported, and a bot's own words are marked unverified", async () => {
  const r = await royalWith({ bridge: fakeBridge() });
  await ask(r, "Who owes us money?");
  const a = await ask(r, "What did the bots do today?");
  assert.equal(a.status, "PARTIAL");
  assert.match(a.summary, /ACE .*its Grok Bot posted 1 update \(reported, not verified\); latest: “Followed up with three qualified leads\. Two replied\.”/);
  assert.ok(!/\*\*|\]\(http/.test(a.summary), "the bot's markdown and links are stripped");
  assert.match(a.summary, /couldn't read its Grok Bot's feed \(feed unavailable\)/);
  assert.match(a.summary, /LEDGER worked 1 request for you: receivables/);
  assert.match(a.summary, /haven't verified it/);
});

test("delegated tasks appear in the review and in active work, failures under needs you", async () => {
  const r = await royalWith();
  const tasks = r.intelligence.tasks;
  const t1 = await tasks.create({ agent: "house", adapter: "grokbot", objective: "Draft Saturday's post", conversation_id: "BUSINESS:c1" });
  await tasks.update(t1.id, { status: "IN_PROGRESS" });
  const t2 = await tasks.create({ agent: "house", adapter: "grokbot", objective: "Caption the pendant reel", conversation_id: "BUSINESS:c1" });
  await tasks.update(t2.id, { status: "FAILED", fail_reason: "BOT_FAILURE" });
  const a = await ask(r, "What did HOUSE do today?");
  assert.match(a.summary, /of 2 tasks I gave its Grok Bot: 1 in progress, 1 failed/); assert.match(a.summary, /Needs you: 1 delegated task failed/);
  const w = await ask(r, "What are you working on?");
  assert.match(w.summary, /HOUSE on “Draft Saturday's post” in progress/); assert.match(w.summary, /1 task failed/);
});

/* -------------------------------------------------------- cancellation --- */

test("a bare “stop” leaves delegated work running and says so; “stop the tasks” cancels it, with the reason recorded", async () => {
  const r = await royalWith();
  const tasks = r.intelligence.tasks;
  const t = await tasks.create({ agent: "house", adapter: "grokbot", objective: "Research the venue", conversation_id: "BUSINESS:c1" });
  await tasks.update(t.id, { status: "IN_PROGRESS" });
  const s1 = await ask(r, "Stop.");
  assert.equal(s1.skill, "intel:cancel");
  assert.match(s1.summary, /One delegated task is still running/);
  assert.equal((await r.store.get("agent_tasks", t.id)).data.status, "IN_PROGRESS");
  const s2 = await ask(r, "Stop the tasks");
  assert.match(s2.summary, /Cancelled 1 delegated task/);
  const after = (await r.store.get("agent_tasks", t.id)).data;
  assert.equal(after.status, "CANCELLED"); assert.equal(after.cancel_reason, "USER_CANCELLED");
  assert.equal(after.history.slice(-1)[0].reason, "USER_CANCELLED");
});

/* ------------------------------------------------------------- ledger --- */

test("runs finishing at the same moment are all counted (compare-and-swap with retry)", async () => {
  const store = new MemoryStore(), l = new AgentActivityLedger({ store, clock: () => NOW });
  await Promise.all(Array.from({ length: 12 }, (_, i) => l.noteRun({ agent: "ace", skill: "sales_pipeline", status: i % 4 ? "OK" : "FAILED", reason: i % 4 ? null : "ERROR" })));
  const d = await l.day("ace", dayOf(NOW));
  assert.equal(d.runs, 12); assert.equal(d.ok, 9); assert.equal(d.failed, 3); assert.equal(d.recent.length, 12);
});

test("two task updates landing together both apply", async () => {
  const store = new MemoryStore(), tasks = new AgentTasks({ store, clock: () => NOW });
  const t = await tasks.create({ agent: "ace", adapter: "grokbot", objective: "x" });
  await Promise.all([tasks.update(t.id, { a: 1 }), tasks.update(t.id, { b: 2 }), tasks.update(t.id, { status: "IN_PROGRESS" })]);
  const d = (await store.get("agent_tasks", t.id)).data;
  assert.equal(d.a, 1); assert.equal(d.b, 2); assert.equal(d.status, "IN_PROGRESS");
});

test("“today” is the House's day, not the server's", () => {
  assert.equal(dayOf(Date.parse("2026-10-01T02:30:00Z")), "2026-09-30", "10:30 pm in Raleigh is still the 30th");
  assert.equal(dayOf(Date.parse("2026-10-01T14:00:00Z")), "2026-10-01");
});

/* --------------------------------------------------------- diagnostics --- */

test("diagnose yourself: each system with its real state and evidence; an unverified or failed bot is never shown as working", async () => {
  const r = await royalWith({ bridge: fakeBridge() });
  const a = await ask(r, "Diagnose yourself");
  assert.equal(a.skill, "self_diagnostic"); assert.match(a.summary, /^I checked \d+ parts of myself/);
  assert.match(a.summary, /Not set up: Language provider/);
  assert.match(a.summary, /Grok Bot: Ace/); assert.match(a.summary, /Degraded:.*Grok Bot: Grace \(configured unverified/);
  assert.match(a.summary, /Failed: Grok Bot: House \(failed/);
  assert.equal(a.status, "PARTIAL");
});

/* ---------------------------------------------------------- stress --- */

test("stress: 20 mixed requests at once, with a timeout, a malformed result and a failing bot: every turn answers, no cross-talk", async () => {
  const saved = { grace: SPECIALISTS.grace, ace: SPECIALISTS.ace };
  let n = 0;
  SPECIALISTS.grace = (ctx) => (++n % 3 === 0 ? new Promise(() => {}) : saved.grace(ctx));   /* every third GRACE run never answers */
  SPECIALISTS.ace = async () => ({ not: "an agent result" });                                 /* ACE returns something malformed */
  try {
    const r = await royalWith({ bridge: fakeBridge(), delegationTimeoutMs: 80 });
    const qs = ["What needs me?", "What did the bots do today?", "What did ACE do today?", "Who owes us money?", "What's happening with production?",
      "Which clients are at risk?", "State of the House", "Diagnose yourself", "What are you working on?", "Why have we been tight on cash?",
      "Stop.", "Hey ROYAL", "Who are you?", "What does production deposit mean?", "What did GRACE do today?", "Any leads in the pipeline?",
      "What are we waiting on?", "Which promises are due?", "Show me revenue leakage.", "Tell me what each Bot did for work today."];
    const results = await Promise.allSettled(qs.map((q, i) => r.handle({ content: q, conversation_id: "conv-" + i })));
    assert.equal(results.filter((x) => x.status === "rejected").length, 0, "no turn throws");
    const vals = results.map((x) => x.value);
    assert.equal(new Set(vals.map((v) => v.run_id)).size, qs.length, "every turn has its own run id");
    vals.forEach((v, i) => {
      assert.ok(v.summary && v.summary.length > 3, qs[i] + ": an answer, not a blank");
      assert.notEqual(v.status, "FAILED", qs[i] + ": " + v.summary);
      assert.ok(v.timing && v.timing.path, qs[i]);
    });
    const ace = vals[0].delegations.find((d) => d.agent === "ace");
    assert.equal(ace.verified, false, "the malformed result was not used");
    const day = await r.ledger.day("ace", dayOf(NOW));
    assert.ok(day.failed >= 1 && day.recent.some((x) => x.reason === "INVALID_RESULT"));
    const gday = await r.ledger.day("grace", dayOf(NOW));
    assert.ok(gday.timed_out >= 1, "GRACE's stalls are recorded as timeouts, not failures of the whole turn");
    assert.equal(gday.runs, gday.ok + gday.timed_out + gday.failed + gday.not_connected, "every GRACE run is accounted for");
  } finally { SPECIALISTS.grace = saved.grace; SPECIALISTS.ace = saved.ace; }
});

test("a skill whose specialist failed says which and why, instead of crashing the turn or showing zeros", async () => {
  const saved = SPECIALISTS.ace;
  SPECIALISTS.ace = async () => ({ not: "an agent result" });
  try {
    const r = await royalWith();
    const a = await ask(r, "Any leads in the pipeline?");
    assert.equal(a.status, "PARTIAL");
    assert.match(a.summary, /^ACE returned something I couldn't use, so I can't give you that answer right now without guessing/);
    assert.ok(!/\$0|0 leads/.test(a.summary), "no zeros standing in for missing data");
  } finally { SPECIALISTS.ace = saved; }
});
