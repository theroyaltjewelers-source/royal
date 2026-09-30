/* ROYAL's skills.  A skill is a named, versioned procedure with declared
   inputs, sources, permissions and completion criteria.  Skills are callable
   by name before they are ever automated; the router is only a way of
   calling them from plain language.

   Every skill returns:
     { summary, status?, findings, surface, data, unresolved? }
   where `surface` tells the interface what to draw (a briefing, a money
   view, a decision list) instead of one more paragraph. */

import { PRIORITY as P, RISK as R, NEED as N, EVIDENCE as E, RUN_STATUS, COMMITMENT_STATUS as CS, DECISION_STATUS as DS } from "../core/enums.js";
import { executive, needsTahir, byAttention } from "../core/attention.js";
import { money, plural, daysBetween, parseDate } from "../core/util.js";
import { diffSnapshots } from "../realms/business/royal-t/changes.js";
import { draftFor } from "./drafts.js";

const ALL = ["ace", "grace", "ledger", "forge"];

function meta(id, name, agents, o = {}) {
  return { id, name, version: "1.0.0", agent: "royal", agents, status: o.status || "ACTIVE",
    purpose: o.purpose || "", trigger: o.trigger || "Command or schedule", required_inputs: o.inputs || [],
    required_sources: o.sources || ["PROJECT_STATUS"], procedure: o.procedure || [],
    output_schema: "SkillOutput{summary,findings[],surface,data}", escalation_rules: o.escalation || "P0 and P1 items surface to Tahir.",
    permission_requirements: o.permissions || ["READ", "ANALYZE"], completion_criteria: o.done || "Every finding carries evidence and an owner.",
    evaluation_metrics: o.metrics || ["missed_escalation", "false_escalation", "source_accuracy"] };
}

async function gather(ctx, agents) {
  const results = await ctx.consult(agents);
  const findings = Object.values(results).flatMap((r) => r.findings || []);
  return { results, findings };
}

function notConnected(results) {
  return Object.values(results).some((r) => r.status === RUN_STATUS.NOT_CONNECTED);
}

function calcDown(ctx) {
  return { status: RUN_STATUS.NOT_CONNECTED, summary: "ROYAL cannot see the calculator, so it cannot answer from verified records. No conclusion was drawn.",
    findings: [], surface: { type: "not_connected", domain: "royal_t", detail: "Open the calculator while signed in; it sends its state to ROYAL." } };
}

async function openDecisions(ctx) { return ctx.decisions.list({ status: DS.OPEN }); }

function decisionItems(ds) {
  return ds.map((d) => ({ id: d.id, kind: "DECISION", code: d.type, agent: d.requested_by_agent, title: d.title, detail: d.description,
    entity: d.related_project_id ? { type: "project", id: d.related_project_id } : null, priority: d.priority, risk: d.risk, need: N.APPROVE,
    owner: "Tahir", due_at: d.deadline, amount: d.financial_impact, evidence: { label: E.VERIFIED, source: "royal.decisions", verified_at: d.created_at },
    link: { decision: d.id } }));
}

export const SKILLS = {};
function skill(m, run) { SKILLS[m.id] = { ...m, run }; }

/* ------------------------------------------------------ what needs me --- */
skill(meta("what_needs_me", "Executive Triage", ALL, { purpose: "What needs Tahir, in order, and nothing that does not." }), async (ctx) => {
  const { results, findings } = await gather(ctx, ALL);
  const ds = decisionItems(await openDecisions(ctx));
  if (notConnected(results) && !ds.length) return calcDown(ctx);
  const need = needsTahir(findings).concat(ds).sort(byAttention);
  return { summary: need.length ? plural(need.length, "thing needs", "things need") + " you." : "Nothing needs you. The House is operating normally.",
    findings: need, surface: { type: "attention", items: need, empty: "NO DECISIONS NEED YOU. THE HOUSE IS OPERATING NORMALLY." } };
});

/* --------------------------------------------------- can i step away --- */
skill(meta("can_i_step_away", "Can I Step Away?", ALL, { purpose: "Whether Tahir can leave for the rest of the day, and what to clear first." }), async (ctx) => {
  const { results, findings } = await gather(ctx, ALL);
  if (notConnected(results)) return { ...calcDown(ctx), summary: "I can't clear you to step away: the calculator isn't connected, so I can't check commitments, payments or production." };
  const ds = decisionItems(await openDecisions(ctx)).filter((d) => d.priority === P.P0 || d.priority === P.P1);
  const blocking = executive(findings).filter((i) =>
    (i.priority === P.P0 || i.priority === P.P1) && [N.DECIDE, N.APPROVE, N.DO].indexOf(i.need) >= 0).concat(ds).sort(byAttention);
  const stale = results.forge && results.forge.data && results.forge.data.calculator && results.forge.data.calculator.freshness === "STALE";
  const clear = blocking.length === 0 && !stale;
  return {
    summary: clear ? "Clear to step away. Nothing today needs you that can't wait for tomorrow's briefing."
      : stale ? "I can't clear you: what I know is stale. " + results.forge.data.calculator.age + "."
      : blocking.length > 5 ? "Before you step away: " + blocking.length + " items need you. The five most urgent are below."
      : "Before you step away: " + plural(blocking.length, "item") + ".",
    findings: blocking,
    surface: { type: "step_away", clear, before: blocking.slice(0, 5), checked: ["decisions", "client commitments", "production deadlines", "payments", "vendor obligations", "system health"],
      not_checked: ["appointments (no calendar connected)"] },
  };
});

/* ---------------------------------------------------- state of house --- */
skill(meta("state_of_house", "State of the House", ALL, { purpose: "One synthesised picture of the business, not a database dump." }), async (ctx) => {
  const { results, findings } = await gather(ctx, ALL);
  if (notConnected(results)) return calcDown(ctx);
  const ds = await openDecisions(ctx);
  const ex = executive(findings);
  const urgent = ex.filter((i) => i.priority === P.P0 || i.priority === P.P1);
  const L = results.ledger.data, G = results.grace.data, A = results.ace.data;
  const worst = ex.reduce((w, i) => (["GREEN", "YELLOW", "ORANGE", "RED", "BLACK"].indexOf(i.risk) > ["GREEN", "YELLOW", "ORANGE", "RED", "BLACK"].indexOf(w) ? i.risk : w), R.GREEN);
  const headline = urgent.length ? plural(urgent.length, "matter needs", "matters need") + " attention today" + (ds.length ? ", and " + plural(ds.length, "decision is", "decisions are") + " open." : ".")
    : ds.length ? "Operating normally. " + plural(ds.length, "decision is", "decisions are") + " waiting on you." : "The House is operating normally.";
  const lines = [
    { k: "Money", v: money(L.receivable) + " outstanding; " + money(L.unfunded) + " of production not yet funded" + (L.treasury && L.treasury.runway_days !== null && L.treasury.runway_days !== undefined ? "; runway " + L.treasury.runway_days + " days" : "") + "." },
    { k: "Production", v: results.grace.summary },
    { k: "Sales", v: results.ace.summary },
    { k: "Commitments", v: (() => { const c = G.commitments; const o = c.filter((x) => x.status === CS.OVERDUE).length, s = c.filter((x) => x.status === CS.DUE_SOON).length; return o || s ? (o ? plural(o, "delivery date") + " passed" : "") + (o && s ? ", " : "") + (s ? plural(s, "due", "due") + " within 7 days" : "") + "." : "No delivery dates at risk."; })() },
    { k: "Systems", v: results.forge.summary },
  ];
  return { summary: headline, findings: urgent.slice(0, 3),
    surface: { type: "state", headline, risk: worst, lines, top: urgent.slice(0, 3), decisions: ds.length } };
});

/* --------------------------------------------------- morning briefing --- */
skill(meta("morning_briefing", "Morning Briefing", ALL, { purpose: "The structured executive briefing. Empty sections are left out." }), async (ctx) => {
  const { results, findings } = await gather(ctx, ALL);
  const dsRaw = await openDecisions(ctx);
  if (notConnected(results)) {
    const c = calcDown(ctx);
    c.surface = { type: "briefing", sections: [{ id: "systems", title: "Systems", text: "The calculator is not connected. Nothing below could be verified, so nothing is shown." }].concat(
      dsRaw.length ? [{ id: "decisions", title: "Open decisions", items: decisionItems(dsRaw) }] : []) };
    return c;
  }
  const ex = executive(findings), need = needsTahir(findings).concat(decisionItems(dsRaw)).sort(byAttention);
  const G = results.grace.data, L = results.ledger.data;
  const today = G.commitments.filter((c) => c.status !== CS.REPORTED_COMPLETE && c.due_at && daysBetween(ctx.now, c.due_at) === 0);
  const sections = [];
  /* Exception-first: an item appears once in the briefing, in the first
     section that claims it.  Long sections show their head and a count; the
     rest is one question away. */
  const used = new Set();
  const add = (id, title, o) => {
    if (o.items) {
      const fresh = o.items.filter((i) => !used.has(i.id) && !(i.entity && i.code && used.has(i.entity.id + ":" + i.code)));
      const cap = o.cap || 5;
      fresh.slice(0, cap).forEach((i) => { used.add(i.id); if (i.entity && i.code) used.add(i.entity.id + ":" + i.code); });
      o = { ...o, items: fresh.slice(0, cap), more: Math.max(0, fresh.length - cap) };
    }
    if ((o.items && o.items.length) || o.text || o.lines) sections.push({ id, title, ...o });
  };
  const state = await SKILLS.state_of_house.run(ctx);
  /* The headline is the answer's summary; the section carries the detail
     only, so nothing is said twice. */
  add("top3", "Top 3 priorities", { items: need.slice(0, 3), cap: 3 });
  add("needs", "Also needs you", { items: need.slice(3), cap: 5, ask: "What needs me?" });
  add("decisions", "Open decisions", { items: decisionItems(dsRaw), cap: 4, ask: "What needs my approval?" });
  add("state", "The House", { lines: state.surface.lines });
  add("today", "Today", { items: today.map((c) => ({ id: c.id, title: c.description, detail: "Promised to " + c.made_to, priority: P.P1, risk: R.ORANGE, need: N.KNOW, entity: { type: "project", id: c.project_id }, evidence: c.evidence })) });
  add("watch", "Client watchlist", { items: ex.filter((i) => i.entity && (i.risk === R.ORANGE || i.risk === R.RED || i.risk === R.BLACK)), cap: 4, ask: "Which clients are at risk?" });
  add("money", "Money", { text: money(L.receivable) + " outstanding. " + money(L.collected) + " collected on live work.", items: ex.filter((i) => i.agent === "ledger"), cap: 3, ask: "Who owes us money?" });
  add("production", "Production", { text: results.grace.summary, items: ex.filter((i) => i.agent === "grace"), cap: 3, ask: "What\u2019s happening with production?" });
  add("sales", "Sales", { text: results.ace.summary, items: ex.filter((i) => i.agent === "ace"), cap: 3, ask: "Any leads in the pipeline?" });
  add("systems", "Systems", { items: ex.filter((i) => i.agent === "forge") });
  add("commitments", "Commitments", { items: G.commitments.filter((c) => c.status === CS.OVERDUE || c.status === CS.DUE_SOON).map((c) => ({ id: c.id, code: c.status === CS.OVERDUE ? "PAST_TARGET" : "DUE_SOON", title: c.description, detail: (c.status === CS.OVERDUE ? "Overdue. " : "Due soon. ") + "Promised to " + c.made_to + ".", priority: c.status === CS.OVERDUE ? P.P1 : P.P2, risk: c.status === CS.OVERDUE ? R.RED : R.YELLOW, need: N.KNOW, entity: { type: "project", id: c.project_id }, evidence: c.evidence })), cap: 3, ask: "Which promises are due?" });
  add("waiting", "Waiting for", { items: G.waiting.filter((w) => w.overdue).map(waitItem), cap: 3, ask: "What are we waiting on?" });
  add("agents", "Agent report", { lines: Object.values(results).map((r) => ({ k: r.agent.toUpperCase(), v: r.summary })) });
  return { summary: state.surface.headline, findings: need, surface: { type: "briefing", sections } };
});

function waitItem(w) {
  return { id: w.id, kind: "WAITING", title: "Waiting on " + w.waiting_for_entity, detail: w.entity.client_name + ", " + w.entity.name + (w.days !== null ? ": " + plural(w.days, "day") + " (since " + w.since_basis + ")" : "") + ".",
    entity: w.entity, priority: w.overdue ? P.P2 : P.P3, risk: w.overdue ? R.YELLOW : R.GREEN, need: w.overdue ? N.DELEGATE : N.MONITOR, owner: w.owner, evidence: w.evidence, link: { project: w.project_id } };
}

/* ------------------------------------------------------- who owes us --- */
skill(meta("who_owes_us", "Cash Arrival Review", ["ledger"], { purpose: "Who owes the House, ordered by what matters.", sources: ["RECEIVABLE", "PAYMENT"] }), async (ctx) => {
  const { results } = await gather(ctx, ["ledger"]);
  if (notConnected(results)) return calcDown(ctx);
  const L = results.ledger.data;
  const items = L.debtors.map((d) => ({ id: "rcv_" + d.entity.id, kind: "RECEIVABLE", title: d.entity.client_name + ": " + money(d.outstanding),
    detail: d.entity.name + ", at " + d.stage + (d.finished ? ". The piece is finished." : "."), entity: d.entity, amount: d.outstanding,
    priority: d.finished ? P.P1 : P.P3, risk: d.finished ? R.ORANGE : R.GREEN, need: d.finished ? N.DO : N.MONITOR, owner: ctx.owners.collections,
    evidence: results.ledger.sources[0], link: { project: d.entity.id, section: "financials" } })).sort(byAttention);
  return { summary: L.debtors.length ? money(L.receivable) + " is owed across " + plural(L.debtors.length, "commission") + ". " + items.filter((i) => i.priority === P.P1).length + " on finished pieces." : "Nobody owes the House anything on live work.",
    findings: items, surface: { type: "money", receivable: L.receivable, collected: L.collected, unfunded: L.unfunded, items, treasury: L.treasury } };
});

/* ------------------------------------------------------- waiting for --- */
skill(meta("waiting_for", "Waiting-For Audit", ["grace"], { purpose: "Every structured dependency, with how long and who owns it." }), async (ctx) => {
  const { results } = await gather(ctx, ["grace"]);
  if (notConnected(results)) return calcDown(ctx);
  const stored = (await ctx.store.list("waiting")).map((r) => r.data).filter((w) => !w.resolved_at);
  const items = results.grace.data.waiting.map(waitItem).concat(stored.map((w) => ({ id: w.id, kind: "WAITING", title: "Waiting on " + w.waiting_for_entity, detail: w.reason || "", priority: P.P3, risk: R.GREEN, need: N.MONITOR, owner: w.owner, evidence: { label: E.REPORTED_UNVERIFIED, source: "royal.store" } }))).sort(byAttention);
  const over = items.filter((i) => i.need === N.DELEGATE).length;
  return { summary: items.length ? plural(items.length, "thing") + " waiting" + (over ? ", " + over + " past their expected time." : ", none past its expected time.") : "Nothing is waiting on anyone.",
    findings: items, surface: { type: "waiting", items } };
});

/* ------------------------------------------------------- commitments --- */
skill(meta("commitments", "Commitment Audit", ["grace"], { purpose: "What the House has promised, and what is due or overdue.", sources: ["COMMITMENT"] }), async (ctx) => {
  const { results } = await gather(ctx, ["grace"]);
  if (notConnected(results)) return calcDown(ctx);
  const stored = (await ctx.store.list("commitments")).map((r) => r.data);
  const all = results.grace.data.commitments.concat(stored);
  const live = all.filter((c) => [CS.OPEN, CS.DUE_SOON, CS.OVERDUE].indexOf(c.status) >= 0).sort((a, b) => (a.due_at || Infinity) - (b.due_at || Infinity));
  const mine = /\b(i|me|my)\b.*\b(promis|commit)/i.test(ctx.text) ;
  const shown = mine ? live.filter((c) => /tahir/i.test(c.made_by)) : live;
  const items = shown.map((c) => ({ id: c.id, kind: "COMMITMENT", title: c.description, detail: "Made by " + c.made_by + " to " + c.made_to + ". " + (c.status === CS.OVERDUE ? "Overdue." : c.status === CS.DUE_SOON ? "Due soon." : "Open."),
    entity: c.project_id ? { type: "project", id: c.project_id } : null, due_at: c.due_at, priority: c.status === CS.OVERDUE ? P.P1 : c.status === CS.DUE_SOON ? P.P2 : P.P4,
    risk: c.status === CS.OVERDUE ? R.RED : c.status === CS.DUE_SOON ? R.YELLOW : R.GREEN, need: c.status === CS.OVERDUE ? N.DECIDE : N.MONITOR, owner: c.owner, evidence: c.evidence }));
  return { summary: mine && !items.length ? "ROYAL has no record of commitments you made personally. Only recorded commitments and project target dates are tracked." :
      items.length ? plural(items.length, "open commitment") + "; " + items.filter((i) => i.priority === P.P1).length + " overdue." : "No open commitments on record.",
    findings: items, surface: { type: "commitments", items } };
});

/* ------------------------------------------------- production status --- */
skill(meta("production_status", "Production Risk Audit", ["grace", "ledger"], { purpose: "Production state, exceptions first." }), async (ctx) => {
  const { results, findings } = await gather(ctx, ["grace", "ledger"]);
  if (notConnected(results)) return calcDown(ctx);
  const ex = executive(findings).filter((i) => i.agent === "grace" || /PRODUCTION/.test(i.code || ""));
  const prod = results.grace.data.in_production;
  const healthy = prod.filter((p) => !ex.some((i) => i.entity && i.entity.id === p.id));
  return { summary: results.grace.summary + (ex.length ? " " + plural(new Set(ex.map((i) => i.entity && i.entity.id)).size, "has an exception", "have exceptions") + "." : " All on track."),
    findings: ex, surface: { type: "production", exceptions: ex, healthy, waiting: results.grace.data.waiting } };
});

/* -------------------------------------------------- clients at risk --- */
skill(meta("clients_at_risk", "Client Risk Audit", ["grace", "ledger", "ace"], { purpose: "Clients whose experience or money is at risk." }), async (ctx) => {
  const { results, findings } = await gather(ctx, ["grace", "ledger", "ace"]);
  if (notConnected(results)) return calcDown(ctx);
  const risky = executive(findings).filter((i) => i.entity && [R.ORANGE, R.RED, R.BLACK].indexOf(i.risk) >= 0);
  const clients = new Map();
  risky.forEach((i) => { const k = i.entity.client_name || i.entity.id; if (!clients.has(k)) clients.set(k, []); clients.get(k).push(i); });
  return { summary: clients.size ? plural(clients.size, "client") + " at risk." : "No client risks detected.",
    findings: risky, surface: { type: "attention", items: risky, empty: "NO CLIENT RISKS DETECTED." } };
});

/* -------------------------------------------------- revenue leakage --- */
skill(meta("revenue_leakage", "Revenue Leakage Review", ["ledger"], { purpose: "Money the House is at risk of not collecting or not earning." }), async (ctx) => {
  const { results } = await gather(ctx, ["ledger"]);
  if (notConnected(results)) return calcDown(ctx);
  const items = results.ledger.findings.filter((i) => ["BALANCE_ON_FINISHED", "BELOW_MARGIN_FLOOR", "PRODUCTION_SHORT_MOVING"].indexOf(i.code) >= 0).sort(byAttention);
  const total = items.reduce((t, i) => t + (i.amount || 0), 0);
  return { summary: items.length ? plural(items.length, "leak") + " found" + (total ? ", " + money(total) + " exposed." : ".") : "No revenue leakage found in the calculator's records.",
    findings: items, surface: { type: "attention", items, empty: "NO REVENUE LEAKAGE FOUND." } };
});

/* ---------------------------------------------------- sales pipeline --- */
skill(meta("sales_pipeline", "Sales Pipeline", ["ace"], { purpose: "Open leads and what is stalled." }), async (ctx) => {
  const { results } = await gather(ctx, ["ace"]);
  if (notConnected(results)) return calcDown(ctx);
  return { summary: results.ace.summary, findings: results.ace.findings, surface: { type: "pipeline", leads: results.ace.data.pipeline, items: results.ace.findings } };
});

/* ----------------------------------------------------- system status --- */
skill(meta("system_status", "System Status", ["forge"], { purpose: "Connections, freshness and integrity.", sources: ["SOFTWARE_STATUS"] }), async (ctx) => {
  const { results } = await gather(ctx, ["forge"]);
  return { summary: results.forge.summary + " Language provider: " + (ctx.provider.status().status === "CONNECTED" ? "connected." : "not connected."),
    findings: results.forge.findings, surface: { type: "systems", calculator: results.forge.data.calculator, provider: ctx.provider.status(), domains: ctx.domains, items: results.forge.findings } };
});

/* ------------------------------------------------------ what changed --- */
skill(meta("what_changed", "What Changed?", [], { purpose: "Differences between the last verified state and the current one." }), async (ctx) => {
  const latest = await ctx.connector.latest();
  if (!latest) return calcDown(ctx);
  const base = await ctx.connector.baseline(ctx.now);
  const d = diffSnapshots(base.rec && base.rec.snapshot, latest.snapshot);
  if (/\b(mark|got it|seen|acknowledge)\b/i.test(ctx.text)) await ctx.connector.checkpoint();
  return { summary: !d.comparable ? "There is nothing earlier to compare against yet." : d.changes.length ? plural(d.changes.length, "change") + " " + base.basis + "." : "Nothing has changed " + base.basis + ".",
    findings: [], surface: { type: "changes", basis: base.basis, changes: d.changes, baseline_at: d.baseline_at, current_at: d.current_at } };
});

/* ---------------------------------------------------- decisions open --- */
skill(meta("decisions_open", "Decision Brief", [], { purpose: "Everything waiting on Tahir's approval.", sources: [] }), async (ctx) => {
  const ds = await openDecisions(ctx);
  return { summary: ds.length ? plural(ds.length, "decision is", "decisions are") + " waiting on you." : "No decisions need you.",
    findings: decisionItems(ds), surface: { type: "decisions", decisions: ds, empty: "NO DECISIONS NEED YOU." } };
});

/* ---------------------------------------------------- project status --- */
skill(meta("project_status", "Project Status", ["grace", "ledger", "ace"], { purpose: "Everything about one commission in the fixed answer format.", inputs: ["entity"] }), async (ctx) => {
  const p = ctx.entity;
  if (!p) return { status: RUN_STATUS.NEEDS_CLARIFICATION, summary: "Which commission do you mean?", findings: [], surface: { type: "clarify", candidates: [] } };
  const { results, findings } = await gather(ctx, ["grace", "ledger", "ace"]);
  if (notConnected(results)) return calcDown(ctx);
  const mine = findings.filter((i) => i.entity && i.entity.id === p.id).sort(byAttention);
  const waiting = results.grace.data.waiting.filter((w) => w.project_id === p.id);
  const cmts = results.grace.data.commitments.filter((c) => c.project_id === p.id);
  const ds = (await ctx.decisions.list()).filter((d) => d.related_project_id === p.id);
  const ev = results.grace.sources[0] || {};
  const why = /\bwhy\b/i.test(ctx.text);
  const blockers = [];
  if (p.next_action && p.next_action.do && p.next_action.do !== "Move it along") blockers.push("The calculator's next step is: " + p.next_action.do.replace(/\.$/, "") + ". " + (p.next_action.why || ""));
  if (p.capital > p.paid + 0.005 && ["Inquiry", "Deposit due", "Production", "Design", "CAD", "Awaiting approval"].indexOf(p.stage) >= 0) blockers.push("Production is not fully funded: " + money(p.capital - p.paid) + " short of the production cost.");
  waiting.forEach((w) => blockers.push("Waiting on " + w.waiting_for_entity + (w.days !== null ? " for " + plural(w.days, "day") : "") + "."));
  const top = mine[0];
  const answer = {
    current_state: p.stage + (p.due ? ", target " + p.due : "") + ". Paid " + money(p.paid) + " of " + money(p.value) + ".",
    why: why ? (blockers.length ? blockers.join(" ") : "Nothing in the records explains a hold. The cause is not recorded, so it is unknown.") : null,
    verified: [
      { text: "Stage " + p.stage, label: E.VERIFIED, source: "calculator", age: ev.age },
      { text: "Paid " + money(p.paid) + ", outstanding " + money(p.outstanding), label: E.VERIFIED, source: "calculator", age: ev.age },
      p.health ? { text: "Calculator health: " + p.health.t, label: E.VERIFIED, source: "calculator", age: ev.age } : null,
      p.next_action ? { text: "Calculator next step: " + p.next_action.do, label: E.VERIFIED, source: "calculator", age: ev.age } : null,
    ].filter(Boolean),
    unknown: ["The manufacturer's current progress (no vendor connection)", "When the client was last updated (no message history connected)"],
    owner: top ? top.owner : ctx.owners.production,
    next_action: top ? top.next_action : (p.next_action ? p.next_action.do : null),
    deadline: p.due || null,
    risk: top ? top.risk : (p.health && p.health.s === "risk" ? R.ORANGE : p.health && p.health.s === "wait" ? R.YELLOW : R.GREEN),
    tahir_required: top ? top.need : N.NONE,
  };
  const verdict = top && [N.DECIDE, N.DO, N.APPROVE].indexOf(top.need) >= 0 ? "Needs you: " + top.title.charAt(0).toLowerCase() + top.title.slice(1) + "."
    : blockers.length ? "Held: " + blockers[0] : "On track. " + answer.current_state;
  return { summary: verdict, findings: mine,
    surface: { type: "project", project: p, answer, items: mine, waiting, commitments: cmts, decisions: ds } };
});

/* ---------------------------------------------------------- handle it --- */
skill(meta("handle_it", "Handle It", ALL, { purpose: "Turn the last set of findings into delegations, drafts and approval requests.",
  permissions: ["DRAFT", "INTERNAL_WRITE", "APPROVAL_REQUIRED"] }), async (ctx) => {
  const items = (ctx.conversation.last_items || []).filter((i) => [N.DO, N.DELEGATE, N.DECIDE].indexOf(i.need) >= 0).slice(0, 6);
  if (!items.length) return { status: RUN_STATUS.NEEDS_CLARIFICATION, summary: "Handle what? Ask me about something first, then tell me to handle it.", findings: [], surface: { type: "text" } };
  const done = [], pending = [], refused = [];
  for (const i of items) {
    const draft = draftFor(i, ctx);
    if (draft) {
      const r = await ctx.gate.request({ agentId: i.agent === "ledger" || i.agent === "ace" || i.agent === "grace" ? i.agent : "royal", tool: "send_client_message", domain: "royal_t", run_id: ctx.run_id,
        args: { project_id: i.entity && i.entity.id, draft },
        decision: { title: "Send " + draft.purpose + " to " + ((i.entity && i.entity.client_name) || "the client"), description: draft.body,
          related_project_id: i.entity && i.entity.id, related_client_id: i.entity && i.entity.client_id, priority: i.priority, risk: i.risk,
          facts: [i.detail], unknowns: ["Whether the client has already been contacted outside ROYAL"], recommended_option: "APPROVE",
          reasoning_summary: "Drafted from verified calculator state. It states no new date or price.", financial_impact: i.amount || null,
          expected_result: "The client receives this message.", source: "calculator", dedupe_key: "send:" + i.id } });
      (r.status === "PENDING_APPROVAL" ? pending : refused).push({ item: i, result: r });
      continue;
    }
    const r = await ctx.gate.request({ agentId: "royal", tool: "create_internal_task", domain: "royal_t", run_id: ctx.run_id,
      args: { title: i.next_action || i.title, owner: i.owner, project_id: i.entity && i.entity.id, source_item: i.id, verification: i.verification },
      decision: { title: "Create task: " + (i.next_action || i.title), description: i.detail, related_project_id: i.entity && i.entity.id,
        priority: i.priority, risk: i.risk, recommended_option: "APPROVE", reasoning_summary: "Internal tasks need approval while agent_internal_write is off.",
        dedupe_key: "task:" + i.id } });
    (r.status === "OK" ? done : r.status === "PENDING_APPROVAL" ? pending : refused).push({ item: i, result: r });
  }
  return {
    summary: [done.length ? plural(done.length, "task") + " created" : "", pending.length ? plural(pending.length, "item") + " waiting on your approval" : "", refused.length ? plural(refused.length, "item") + " ROYAL could not act on" : ""].filter(Boolean).join("; ") + ". Nothing was sent to a client.",
    findings: [], surface: { type: "handled", done, pending, refused, verification: "Each item clears when the calculator's records change; ROYAL rechecks at the next reading." } };
});

/* --------------------------------------------------- outside the house --- */
skill(meta("personal", "Personal Intelligence", [], { purpose: "Tahir's own domains: wealth, calendar, personal tasks.", sources: ["APPOINTMENT"] }), async (ctx) => {
  const ds = ctx.domains.filter((d) => d.realm === "PERSONAL");
  return { status: RUN_STATUS.NOT_CONNECTED, summary: "Your personal realm is not connected yet. ROYAL won't guess at your calendar, wealth or tasks.",
    findings: [], surface: { type: "not_connected", realm: "PERSONAL", domains: ds } };
});
skill(meta("other_business", "Other Business Lines", [], { purpose: "Tahir & Co. and Gold Buy." }), async (ctx) => {
  const ds = ctx.domains.filter((d) => ["tahir_and_co", "gold_buy"].indexOf(d.id) >= 0);
  return { status: RUN_STATUS.NOT_CONNECTED, summary: ds.map((d) => d.name).join(" and ") + " are not connected to ROYAL. Their records are separate from Royal T and ROYAL won't mix them.",
    findings: [], surface: { type: "not_connected", realm: "BUSINESS", domains: ds } };
});

/* Planned skills: registered so they are visible and callable-by-name later,
   but they say plainly that they are not built. */
["Pickup Readiness", "Event Deadline Protection", "End-of-Day Close", "Weekly CEO Review", "Deadline Radar", "Open Loop Audit",
 "House Standards Audit", "Contradiction Audit", "Tahir Bottleneck Audit"].forEach((name) => {
  const id = name.toLowerCase().replace(/[^a-z]+/g, "_").replace(/_$/, "");
  skill(meta(id, name, [], { status: "PLANNED" }), async () => ({ status: RUN_STATUS.NOT_CONNECTED, summary: name + " is planned but not built yet.", findings: [], surface: { type: "text" } }));
});

export function skillCatalog() {
  return Object.values(SKILLS).map(({ run, ...m }) => m);
}
