/* The executive knowledge fabric, cash from real numbers, and congruence.
   Concepts come from the curated reference (docs/knowledge/), labelled as
   general reference; House documents outrank it and House policy questions
   never fall back to it; current tax and law go to live research; the
   House's data is checked against itself and conflicts are reported. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoyal } from "../core/royal.js";
import { MemoryStore } from "../core/store.js";
import { KnowledgeEngine } from "../core/intelligence/knowledge.js";
import { congruence } from "../core/congruence.js";
import { route } from "../core/router.js";
import { house, NOW } from "./fixtures.js";

const DOCS = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");
let K = null;
const knowledge = async () => { if (!K) { K = new KnowledgeEngine(); await K.ingestDir(DOCS); } return K; };
async function royal() { const r = createRoyal({ store: new MemoryStore(), knowledge: await knowledge(), clock: () => NOW }); await r.ingestCalculator(house()); return r; }
const ask = (r, q) => r.handle({ content: q, conversation_id: "c1" });

/* Each pack's benchmark questions, and a phrase its answer must carry. */
const BENCH = [
  ["cfo", "What is working capital?", /current assets minus current liabilities/],
  ["cfo", "How does A/R affect cash?", /cash not yet in the bank/],
  ["cfo", "What is the difference between gross margin and cash flow?", /money that actually moves|profit on each sale/],
  ["cfo", "What is break-even?", /fixed costs divided by contribution margin/],
  ["accounting", "How do COGS and inventory relate?", /beginning inventory plus purchases minus ending inventory/],
  ["accounting", "What is a bank reconciliation?", /matches the ledger's cash balance to the bank statement/],
  ["accounting", "What is a journal entry?", /debits equal credits/],
  ["cto", "What is idempotency?", /same effect as doing it once/],
  ["cto", "When should we use an event-driven architecture?", /many parts need to know about a change/],
  ["ceo", "How should we think about opportunity cost?", /alternative|opportunity cost/i],
  ["ceo", "What is a moat?", /moat/],
  ["cro", "How should we qualify leads?", /budget, timeline, decision maker/],
  ["jewelry", "What is 14k gold?", /58\.3 percent/],
  ["jewelry", "What are the 4Cs?", /Cut .*color .*clarity .*carat/],
];

test("each knowledge pack answers its benchmark questions, labelled as general reference and with no model", async () => {
  const r = await royal();
  for (const [pack, q, must] of BENCH) {
    const a = await ask(r, q);
    assert.notEqual(a.status, "FAILED", q);
    assert.match(a.summary, must, q + " -> " + a.summary.slice(0, 160));
    const surf = a.presentation && JSON.stringify(a.presentation.surfaces);
    assert.match(String(surf), /knowledge\/|business reference/, q + ": cites the reference");
    assert.equal(a.timing.model_calls, 0, q);
  }
});

test("the reference is never used for House policy, and its metadata is not searchable", async () => {
  const k = await knowledge();
  const dep = k.search("What is our design deposit?")[0];
  assert.equal(dep.policy_id, "POL-PAY-001", "House policy outranks the reference");
  assert.ok(!k.search("benchmark questions document_id source_type").some((h) => h.namespace === "fabric"), "metadata is kept with the document, not searched");
  const meta = [...k.docs.values()].find((d) => d.path === "knowledge/cfo.md").meta;
  assert.equal(meta.document_id, "kf-cfo-1"); assert.match(meta.authority_level, /House documents and live House data outrank it/);
  const r = await royal();
  const a = await ask(r, "What is the design deposit policy?");
  assert.ok(!/business reference/.test(JSON.stringify(a.presentation)), "a House policy question gets no general-reference answer");
});

test("current tax and law are never answered from the reference: they go to live research, or say they can't", async () => {
  for (const q of ["What is the sales tax rate in North Carolina?", "What's the filing deadline for estimated taxes?", "Is it legal to ship gold to Canada?"]) assert.notEqual(route(q).skill, "sales_pipeline", q);
  const r = await royal();
  const a = await ask(r, "What is the sales tax rate in North Carolina?");
  assert.equal(a.status, "NOT_CONNECTED"); assert.match(a.summary, /current official sources/); assert.match(a.summary, /accountant or lawyer should confirm/);
});

test("concept questions with House words still go to knowledge; House questions still go to the House", () => {
  assert.equal(route("What is the difference between gross margin and cash flow?").reason, "CONCEPT");
  assert.equal(route("How should we qualify leads?").reason, "CONCEPT");
  assert.equal(route("What are we waiting on?").skill, "waiting_for");
  assert.equal(route("What's happening with production?").skill, "production_status");
  assert.equal(route("What is our margin?").skill, "revenue_leakage");
});

/* -------------------------------------------------------- cash analysis --- */

test("why cash is tight: the calculator's own numbers, fact apart from recommendation, the limits said, and no model", async () => {
  const r = await royal();
  const a = await ask(r, "Why have we been tight on cash?");
  assert.equal(a.skill, "cash_analysis"); assert.equal(a.timing.model_calls, 0);
  assert.match(a.summary, /^The calculator shows \$21,000 available, \$30,400 owed to us/);
  assert.match(a.summary, /62 days of runway by its calculation/, "the runway is the calculator's, not recomputed");
  assert.match(a.summary, /\$3,700 of what we're owed is on finished pieces/);
  assert.match(a.summary, /My recommendation: /);
  assert.match(a.summary, /I can't see the bank, expenses or month-by-month history/);
});

/* ------------------------------------------------------------ congruence --- */

test("the House's data is checked against itself, and a conflict is reported, never silently resolved", async () => {
  const c = congruence(house());
  assert.deepEqual(c.issues.map((i) => i.code).sort(), ["PAYABLE_MISMATCH", "RECEIVABLE_MISMATCH"]);
  assert.match(c.issues.find((i) => i.code === "RECEIVABLE_MISMATCH").text, /\$30,400 .* \$30,900/);
  const s = house(); s.treasury.receivable = s.projects.filter((p) => !p.archived && !p.deleted).reduce((a, p) => a + Math.max(0, p.outstanding), 0); s.treasury.inbox = [];
  assert.equal(congruence(s).ok, true, "agreeing figures raise nothing");
  const d = house(); d.projects[0].outstanding += 500; d.clients.push({ id: "CL-999", name: d.clients[0].name, has_email: false });
  const codes = congruence(d).issues.map((i) => i.code);
  assert.ok(codes.includes("PROJECT_BALANCE_MISMATCH") && codes.includes("POSSIBLE_DUPLICATE_CLIENT"));
  const r = await royal();
  const a = await ask(r, "Why have we been tight on cash?");
  assert.match(a.summary, /Two things don't add up/); assert.match(a.summary, /I haven't picked one side/);
});
