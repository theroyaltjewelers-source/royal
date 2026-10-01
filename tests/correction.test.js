/* The correction pass: ROYAL thinks only as hard as a request needs, keeps
   one conversation warm in the provider's cache, answers simple things with
   no model at all, makes one model call where it used to make two, speaks in
   the first person, and knows the House's words.  The provider runs against
   a stand-in xAI that records every request. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoyal } from "../core/royal.js";
import { MemoryStore } from "../core/store.js";
import { GrokProvider, effortFor } from "../core/providers/grok.js";
import { runTraced } from "../core/trace.js";
import { identityPrompt, fastPath, describeSelf } from "../core/identity.js";
import { definitionQuery, lookupTerm, houseLanguagePrompt, HOUSE_LANGUAGE } from "../core/house_language.js";
import { voiceSessionConfig } from "../server/handler.js";
import { house, NOW } from "./fixtures.js";

const KEY = "xai-SECRETSECRETSECRET1234";
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* A stand-in xAI: records each request; answers chat with `reply`. */
function xai({ reply = () => ({ answer: "Two things need you.", needs_outside_world: false, based_on: ["f0"], unknowns: [], proposed_actions: [] }), reject = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body), c = { url: String(url), headers: init.headers, body };
    calls.push(c);
    if (reject) { const r = reject(c); if (r) return r; }
    if (/chat\/completions$/.test(c.url)) return json(200, { choices: [{ message: { content: JSON.stringify(reply(c)) } }], usage: { total_tokens: 900, prompt_tokens_details: { cached_tokens: 700 } } });
    return json(200, { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ intent: "unknown" }) }] }] });
  };
  return { calls, provider: new GrokProvider({ apiKey: KEY, model: "grok-4.3", fetchImpl }) };
}

/* ---------------------------------------------------------- provider --- */

test("reasoning effort follows how hard the request is: low for conversation and lookups, high only for planning", () => {
  assert.equal(effortFor(undefined), "low");
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(effortFor), ["low", "low", "low", "medium", "medium", "high"]);
});

test("every model call carries its effort and the conversation's cache key; the key is never sent as content", async () => {
  const { calls, provider } = xai();
  await runTraced({ conversation: "BUSINESS:c1" }, async () => {
    await provider.complete({ system: "s", messages: [{ role: "user", content: "hi" }], level: 1 });
    await provider.respond({ system: "s", messages: [{ role: "user", content: "hi" }], level: 4 });
  });
  assert.equal(calls[0].body.reasoning_effort, "low");
  assert.equal(calls[0].headers["x-grok-conv-id"], "BUSINESS:c1");
  assert.deepEqual(calls[1].body.reasoning, { effort: "medium" });
  assert.equal(calls[1].body.prompt_cache_key, "BUSINESS:c1");
  assert.ok(!JSON.stringify(calls.map((c) => c.body)).includes("SECRETSECRET"));
});

test("a model that rejects reasoning effort is asked once without it, and never sent it again", async () => {
  const { calls, provider } = xai({ reject: (c) => (c.body.reasoning_effort ? json(400, { error: { message: "Model does not support parameter reasoning_effort" } }) : null) });
  assert.equal((await provider.complete({ messages: [{ role: "user", content: "a" }] })).ok, true);
  assert.equal((await provider.complete({ messages: [{ role: "user", content: "b" }] })).ok, true);
  assert.deepEqual(calls.map((c) => !!c.body.reasoning_effort), [true, false, false], "one failed attempt, then never again");
});

/* -------------------------------------------------- model calls per path --- */

async function royalWith(x) {
  const r = createRoyal({ store: new MemoryStore(), provider: x.provider, clock: () => NOW });
  await r.ingestCalculator(house());
  return r;
}
const ask = (r, content, realm) => r.handle({ content, conversation_id: "c1", realm });

test("greeting, who are you, thanks and House words: answered at once with no model call", async () => {
  const x = xai(); const r = await royalWith(x);
  for (const q of ["Hey ROYAL.", "Good morning", "Who are you?", "What can you do?", "Thanks", "What does production deposit mean?", "What's the difference between CAD approval and a design deposit?"]) {
    const a = await ask(r, q);
    assert.equal(a.timing.model_calls, 0, q); assert.equal(a.timing.path.startsWith("house:"), true, q);
    assert.notEqual(a.status, "FAILED", q + ": " + a.summary);
  }
  assert.equal(x.calls.length, 0);
});

test("a question the rules can't place costs one model call at low effort, not a classify call and then an answer", async () => {
  const x = xai(); const r = await royalWith(x);
  const a = await ask(r, "Give me your read on the workload this week");
  assert.equal(a.timing.model_calls, 1, JSON.stringify(a.timing));
  assert.equal(a.timing.calls[0].effort, "low");
  assert.equal(a.timing.calls[0].cached_tokens, 700, "cached prompt tokens are measured");
  assert.match(a.summary, /Two things need you/);
  assert.ok(a.timing.total_ms >= 0 && a.timing.marks.intent_complete !== undefined);
});

test("House records stay with the House: no model call for what Marcus owes", async () => {
  const x = xai(); const r = await royalWith(x);
  const a = await ask(r, "What does Marcus owe?");
  assert.equal(a.timing.model_calls, 0); assert.match(a.summary, /Marcus Hill owes/);
});

/* ------------------------------------------------------------ identity --- */

test("ROYAL speaks in the first person: no answer calls itself ROYAL in the third person", async () => {
  const bare = createRoyal({ store: new MemoryStore(), clock: () => NOW });   /* no calculator, no provider: the failure lines too */
  const x = xai(); const full = await royalWith(x);
  const third = /\bROYAL(?:'s)? (is|has|was|will|won'?t|can|can'?t|cannot|could|couldn'?t|does|doesn'?t|did|found|recommends|checked|checks|sees|knows|needs|keeps|rechecks|respects|proposes|kept|holds)\b|\bROYAL proposes\b/;
  const qs = ["What needs me?", "State of the House", "Who owes us money?", "What are we waiting on?", "Which promises are due?", "Handle it.", "What changed today?",
    "Is the calculator connected?", "Who are you?", "Hey", "What's on my calendar tomorrow?", "How is Tahir & Co doing?", "Which commitments did I make personally?"];
  for (const r of [bare, full]) for (const q of qs) {
    const a = await ask(r, q);
    const said = JSON.stringify([a.summary, a.presentation && a.presentation.speech, a.findings, a.presentation && a.presentation.surfaces]);
    assert.ok(!third.test(said), q + " says: " + (third.exec(said) || [])[0]);
  }
  for (const q of ["Hey", "Who are you?", "What's on my calendar?"]) {
    const a = await ask(bare, q, "PERSONAL");
    assert.ok(!third.test(a.summary), q + " (Personal) says: " + a.summary);
  }
});

test("who ROYAL is: first person, from what is really connected, and never a connection that isn't there", () => {
  const on = describeSelf({ calculator: true, research: true, model: true, specialists: ["ace", "grace"] });
  assert.match(on, /^I'm ROYAL/); assert.match(on, /I can see the Project Calculator/); assert.match(on, /research the outside world/); assert.match(on, /ACE and GRACE/);
  const off = describeSelf({ calculator: false, model: false, specialists: [] });
  assert.match(off, /I can't see the Project Calculator/); assert.match(off, /isn't connected/); assert.ok(!/I can see/.test(off));
  const personal = describeSelf({ personal_connected: [] }, { realm: "PERSONAL" });
  assert.ok(!/Calculator|House of Royal T/.test(personal), "the Personal side says nothing about the business");
});

test("one identity everywhere: every prompt starts with it, and the realtime voice uses it too", () => {
  const id = identityPrompt();
  assert.match(id, /first person/); assert.match(id, /Never call yourself ROYAL in the third person/); assert.ok(!/\d{4}-\d{2}-\d{2}/.test(id), "no dates in the cacheable prefix");
  assert.ok(voiceSessionConfig().instructions.startsWith(id));
  assert.match(voiceSessionConfig().instructions, /I'll check/);
});

test("the fast path catches only what it should", () => {
  for (const t of ["hey", "Hey ROYAL!", "good evening", "Who are you?", "what can you do", "thanks royal"]) assert.ok(fastPath(t), t);
  for (const t of ["Hey, what does Marcus owe?", "who are you sending it to", "thanks, now send it", "Who is Nike's CFO?"]) assert.equal(fastPath(t), null, t);
});

/* ------------------------------------------------------- House language --- */

test("House words come from House sources, with Tahir's open questions left open", () => {
  for (const e of HOUSE_LANGUAGE) assert.ok(e.source && e.def, e.term);
  assert.match(lookupTerm("production deposit").source, /Company Bible, Article VI\(g\)/);
  assert.match(lookupTerm("production deposit").confirm, /percentage/);
  assert.equal(lookupTerm("qc").say, "Quality control");
  assert.equal(lookupTerm("Balance due").stage, true);
  assert.equal(lookupTerm("teleportation"), null);
  assert.match(houseLanguagePrompt(), /not yet confirmed by Tahir/);
});

test("a definition is House knowledge, a balance is House state", () => {
  assert.ok(definitionQuery("What does production deposit mean?"));
  assert.ok(definitionQuery("what do we mean by CAD approval"));
  const d = definitionQuery("What's the difference between CAD complete and CAD approved?");
  assert.equal(d.terms[0].say, "CAD approval"); assert.deepEqual(d.unknown, ["cad complete"]);
  assert.equal(definitionQuery("What is Marcus's balance?"), null);
  assert.equal(definitionQuery("What does Marcus owe?"), null);
  assert.equal(definitionQuery("What does EBITDA mean?"), null, "not a House word: research or the model takes it");
});
