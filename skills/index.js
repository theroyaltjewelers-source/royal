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
import { money, plural, daysBetween, parseDate, stableHash } from "../core/util.js";
import { diffSnapshots } from "../realms/business/royal-t/changes.js";
import { draftFor } from "./drafts.js";
import { describeSelf, greetingLine } from "../core/identity.js";
import { definitionQuery } from "../core/house_language.js";
import { objectiveWords as objectiveWordsFor, dayOf } from "../core/agent_ledger.js";
import { congruence } from "../core/congruence.js";

const ALL = ["ace", "grace", "ledger", "forge"];

function meta(id, name, agents, o = {}) {
  return { id, name, version: "1.0.0", agent: "royal", agents, status: o.status || "ACTIVE", realm: o.realm || "BUSINESS",
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

/* A specialist this answer depends on didn't finish (timed out, failed,
   returned something invalid).  Say which and why, and keep the turn: never
   fill the gap with zeros or empty lists, which would read as facts. */
const WHY = { TIMEOUT: "didn't finish in time", INVALID_RESULT: "returned something I couldn't use", ERROR: "hit an error", NOT_CONNECTED: "isn't connected" };
function unavailable(results, needs) {
  const down = needs.filter((a) => results[a] && results[a].status !== RUN_STATUS.NOT_CONNECTED && !results[a].data);
  if (!down.length) return null;
  const why = (a) => { const s = String(results[a].summary || ""); return /in time/.test(s) ? WHY.TIMEOUT : /invalid/.test(s) ? WHY.INVALID_RESULT : WHY.ERROR; };
  return { status: RUN_STATUS.PARTIAL, summary: down.map((a) => a.toUpperCase() + " " + why(a)).join(", and ") + ", so I can't give you that answer right now without guessing. Asking again usually works; the rest of what I know is unchanged.",
    findings: needs.filter((a) => results[a] && results[a].data).flatMap((a) => results[a].findings || []), surface: { type: "text" } };
}

function notConnected(results) {
  return Object.values(results).some((r) => r.status === RUN_STATUS.NOT_CONNECTED);
}

function calcDown(ctx) {
  return { status: RUN_STATUS.NOT_CONNECTED, summary: "I can't see the calculator, so I can't answer from verified records. I haven't drawn any conclusion.",
    findings: [], surface: { type: "not_connected", domain: "royal_t", detail: "Open the calculator while signed in; it sends its state to me." } };
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

/* -------------------------------------------------------- home status --- */
/* The command screen's header: one word for the House, the systems that are
   really connected, and three counts.  Every number comes from the same
   specialists as every other answer; nothing here is decorative. */
skill(meta("home_status", "Home Status", ALL, { purpose: "The command screen: House status, systems, and the three counts." }), async (ctx) => {
  const { results, findings } = await gather(ctx, ALL);
  { const miss = unavailable(results, ["ledger"]); if (miss) return miss; }
  const ds = await openDecisions(ctx);
  const domains = ctx.domains.filter((d) => d.realm === "BUSINESS");
  const provider = ctx.provider.status();
  const systems = domains.map((d) => ({ name: d.name, connected: d.status === "CONNECTED" }))
    .concat([{ name: "Language (Grok)", connected: provider.status === "CONNECTED" }]);
  const agents = Object.values(results).map((r) => ({ id: r.agent, ok: r.status === RUN_STATUS.OK, status: r.status }));
  if (notConnected(results)) return { status: RUN_STATUS.NOT_CONNECTED, summary: "No business data yet: the calculator is not connected.",
    findings: [], surface: { type: "home", house: "NO DATA", needs: ds.length, clients_attention: null, projects_active: null, money_outstanding: null, systems, agents } };
  const need = needsTahir(findings).concat(decisionItems(ds));
  const house = need.some((i) => i.priority === P.P0) ? "CRITICAL" : need.some((i) => i.priority === P.P1) ? "ATTENTION" : "NOMINAL";
  const clients = new Set(need.filter((i) => i.entity && (i.entity.client_id || i.entity.client_name)).map((i) => i.entity.client_id || i.entity.client_name));
  const act = await ctx.read("grace", "get_active_projects");
  const active = act.ok ? act.data.filter((p) => ["Delivered", "Archived"].indexOf(p.stage) < 0).length : null;
  return { summary: house === "NOMINAL" ? "All systems operational." : plural(need.length, "matter needs", "matters need") + " you.",
    findings: need.slice(0, 3),
    surface: { type: "home", house, needs: need.length, clients_attention: clients.size, projects_active: active,
      money_outstanding: results.ledger.data.receivable, systems, agents, top: need.slice(0, 3) } };
});

/* ---------------------------------------------------- command center --- */
/* The home screen.  Every figure and every light is computed from verified
   state; nothing is decorative.  When something cannot be seen, it says so. */
skill(meta("command_center", "Command Center", ALL, { purpose: "The home screen: House status, systems, and the three numbers that matter." }), async (ctx) => {
  const { results, findings } = await gather(ctx, ALL);
  { const miss = unavailable(results, ["ledger"]); if (miss) return miss; }
  const dsRaw = await openDecisions(ctx);
  const calc = await ctx.connector.status(ctx.now);
  const prov = ctx.provider.status();
  const doms = ctx.domains.filter((d) => d.realm === "BUSINESS");
  const systems = [{ id: "calculator", name: "Calculator", on: !!calc.connected, detail: calc.connected ? calc.age : "not connected" },
    { id: "language", name: "Grok", on: prov.status === "CONNECTED", detail: prov.status === "CONNECTED" ? "connected" : "not connected" }]
    .concat(doms.filter((d) => d.id !== "royal_t").map((d) => ({ id: d.id, name: d.name, on: d.status === "CONNECTED", detail: d.status === "CONNECTED" ? "connected" : "not connected" })));
  const agents = ["ace", "grace", "ledger", "forge"].map((id) => {
    const r = results[id] || {};
    const items = (r.findings || []).filter((f) => f.need && f.need !== N.NONE);
    return { id, name: id.toUpperCase(), state: r.status === RUN_STATUS.OK ? (items.some((f) => f.priority === P.P0 || f.priority === P.P1) ? "attention" : "ok") : "off", items: items.length };
  });
  const base = { type: "command_center", realm: "BUSINESS", systems, connected: systems.filter((x) => x.on).length, total: systems.length, agents, decisions: dsRaw.length };
  if (notConnected(results))
    return { status: RUN_STATUS.NOT_CONNECTED, summary: "I can't see the House yet. The calculator isn't connected.", findings: [],
      surface: { ...base, level: "OFFLINE", headline: "I can't see the House yet.", prompt: "Open the calculator signed in, and I'll connect.", metrics: null } };
  const ex = executive(findings), need = needsTahir(findings).concat(decisionItems(dsRaw)).sort(byAttention);
  const alert = ex.some((i) => i.priority === P.P0 || i.risk === R.BLACK);
  const level = alert ? "ALERT" : need.length ? "ATTENTION" : "NOMINAL";
  const clients = new Set(ex.filter((i) => i.entity && i.entity.client_name && ([R.ORANGE, R.RED, R.BLACK].indexOf(i.risk) >= 0 || [N.DO, N.DECIDE].indexOf(i.need) >= 0)).map((i) => i.entity.client_id || i.entity.client_name));
  const latest = await ctx.connector.latest();
  const active = latest.snapshot.projects.filter((p) => !p.archived && !p.deleted && ["Delivered", "Archived"].indexOf(p.stage) < 0).length;
  const L = results.ledger.data;
  const headline = level === "NOMINAL" ? "All systems operational." : level === "ALERT" ? "Something needs you now." : plural(need.length, "thing needs", "things need") + " you.";
  return { summary: headline, findings: need.slice(0, 5),
    surface: { ...base, level, headline, prompt: "What do you need?", top: need.slice(0, 3),
      metrics: [{ k: "CLIENTS", v: String(clients.size).padStart(2, "0"), sub: "need attention", q: "Which clients are at risk?" },
                { k: "PROJECTS", v: String(active).padStart(2, "0"), sub: "active", q: "What's happening with production?" },
                { k: "MONEY", v: L.receivable >= 1000 ? "$" + (L.receivable / 1000).toFixed(1) + "K" : money(L.receivable), sub: "expected", q: "Who owes us money?" }],
      age: calc.age } };
});

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
  { const miss = unavailable(results, ["ledger", "grace", "ace"]); if (miss) return miss; }
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
  { const miss = unavailable(results, ["grace", "ledger"]); if (miss) return miss; }
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
  { const miss = unavailable(results, ["ledger"]); if (miss) return miss; }
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
  { const miss = unavailable(results, ["grace"]); if (miss) return miss; }
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
  { const miss = unavailable(results, ["grace"]); if (miss) return miss; }
  const stored = (await ctx.store.list("commitments")).map((r) => r.data);
  const all = results.grace.data.commitments.concat(stored);
  const live = all.filter((c) => [CS.OPEN, CS.DUE_SOON, CS.OVERDUE].indexOf(c.status) >= 0).sort((a, b) => (a.due_at || Infinity) - (b.due_at || Infinity));
  const mine = /\b(i|me|my)\b.*\b(promis|commit)/i.test(ctx.text) ;
  const shown = mine ? live.filter((c) => /tahir/i.test(c.made_by)) : live;
  const items = shown.map((c) => ({ id: c.id, kind: "COMMITMENT", title: c.description, detail: "Made by " + c.made_by + " to " + c.made_to + ". " + (c.status === CS.OVERDUE ? "Overdue." : c.status === CS.DUE_SOON ? "Due soon." : "Open."),
    entity: c.project_id ? { type: "project", id: c.project_id } : null, due_at: c.due_at, priority: c.status === CS.OVERDUE ? P.P1 : c.status === CS.DUE_SOON ? P.P2 : P.P4,
    risk: c.status === CS.OVERDUE ? R.RED : c.status === CS.DUE_SOON ? R.YELLOW : R.GREEN, need: c.status === CS.OVERDUE ? N.DECIDE : N.MONITOR, owner: c.owner, evidence: c.evidence }));
  return { summary: mine && !items.length ? "I have no record of commitments you made personally. Only recorded commitments and project target dates are tracked." :
      items.length ? plural(items.length, "open commitment") + "; " + items.filter((i) => i.priority === P.P1).length + " overdue." : "No open commitments on record.",
    findings: items, surface: { type: "commitments", items } };
});

/* ------------------------------------------------- production status --- */
skill(meta("production_status", "Production Risk Audit", ["grace", "ledger"], { purpose: "Production state, exceptions first." }), async (ctx) => {
  const { results, findings } = await gather(ctx, ["grace", "ledger"]);
  if (notConnected(results)) return calcDown(ctx);
  { const miss = unavailable(results, ["grace"]); if (miss) return miss; }
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
  { const miss = unavailable(results, ["ace"]); if (miss) return miss; }
  return { summary: results.ace.summary, findings: results.ace.findings, surface: { type: "pipeline", leads: results.ace.data.pipeline, items: results.ace.findings } };
});

/* ----------------------------------------------------- system status --- */
skill(meta("system_status", "System Status", ["forge"], { purpose: "Connections, freshness and integrity.", sources: ["SOFTWARE_STATUS"] }), async (ctx) => {
  const { results } = await gather(ctx, ["forge"]);
  { const miss = unavailable(results, ["forge"]); if (miss) return miss; }
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

/* ------------------------------------------------------ daily digest --- */
/* "What happened today?": the day from records only.  Business events the
   calculator's snapshots produced, decisions raised and resolved, what my
   specialists ran, what the Grok Bots reported (their own words, not
   verified), and how fresh the calculator is.  No model, nothing invented. */
skill(meta("daily_digest", "Daily House Digest", [], { purpose: "What happened today, from events, decisions, the agent ledger and the calculator.", sources: [] }), async (ctx) => {
  const now = ctx.now || Date.now(), today = dayOf(now);
  const onDay = (t) => t != null && dayOf(typeof t === "number" ? t : Date.parse(t)) === today;
  const parts = [], missing = [];
  const calc = await ctx.connector.status(now);
  if (!calc.connected) missing.push("the Project Calculator (never connected)");
  else if (calc.freshness === "STALE") parts.push("The calculator last reported " + calc.age + ", so anything since then is missing.");
  let evs = [];
  try { evs = (ctx.events ? await ctx.events.recent({ limit: 500 }) : []).filter((e) => onDay(e.occurred_at)); } catch (_) { missing.push("the event log"); }
  const of = (...types) => evs.filter((e) => types.indexOf(e.type) >= 0);
  const said = (e) => (e.payload && e.payload.text ? String(e.payload.text).replace(/\.$/, "") : null);
  const pay = of("PAYMENT_RECEIVED"), moved = of("PRODUCTION_STAGE_CHANGED"), ready = of("PROJECT_READY"), fresh = of("LEAD_CREATED"),
    sent = of("MESSAGE_SENT"), bounced = of("MESSAGE_FAILED"), broken = of("INTEGRATION_FAILED");
  const list = (xs, n = 3) => xs.map(said).filter(Boolean).slice(0, n).join("; ");
  if (pay.length) parts.push(plural(pay.length, "payment") + " came in" + (list(pay) ? ": " + list(pay) : "") + ".");
  if (ready.length) parts.push(plural(ready.length, "piece") + " became ready" + (list(ready) ? ": " + list(ready) : "") + ".");
  if (moved.length) parts.push(plural(moved.length, "stage change") + (list(moved) ? ": " + list(moved) : "") + ".");
  if (fresh.length) parts.push(plural(fresh.length, "new project") + " opened.");
  if (sent.length || bounced.length) parts.push((sent.length ? plural(sent.length, "message") + " sent" : "") + (sent.length && bounced.length ? ", " : "") + (bounced.length ? bounced.length + " failed" : "") + ".");
  if (broken.length) parts.push("The calculator sent " + plural(broken.length, "snapshot") + " I had to refuse.");
  let ds = [];
  try { ds = await ctx.decisions.list(); } catch (_) { missing.push("decisions"); }
  const raised = ds.filter((d) => onDay(d.created_at)), resolved = ds.filter((d) => d.resolved_at && onDay(d.resolved_at));
  if (raised.length || resolved.length) parts.push((raised.length ? plural(raised.length, "decision") + " raised" : "") + (raised.length && resolved.length ? ", " : "") + (resolved.length ? resolved.length + " resolved" : "") + ".");
  if (ctx.ledger) {
    try {
      const rv = await ctx.ledger.review({ day: today, tasks: ctx.tasks, bridge: ctx.bridge, realm: "BUSINESS" });
      const runs = rv.agents.reduce((a, x) => a + (x.native ? x.native.runs : 0), 0);
      const failed = rv.agents.reduce((a, x) => a + (x.native ? x.native.failed + x.native.timed_out : 0) + (x.delegated || []).filter((t) => ["FAILED", "TIMED_OUT"].indexOf(t.status) >= 0).length, 0);
      const reports = rv.agents.filter((x) => Array.isArray(x.feed) && x.feed.length).map((x) => x.name);
      if (runs) parts.push("My specialists ran " + plural(runs, "time") + (failed ? ", " + failed + " didn't finish" : "") + ".");
      if (reports.length) parts.push(reports.join(" and ") + " posted updates (their own report, not verified).");
    } catch (_) { missing.push("the agent ledger"); }
  }
  const head = parts.length ? "Here's today. " : "Nothing is recorded for today yet. ";
  const tail = missing.length ? " I couldn't read " + missing.join(", ") + ", so that part is missing." : "";
  return { status: missing.length ? RUN_STATUS.PARTIAL : RUN_STATUS.OK, summary: (head + parts.join(" ") + tail).trim(), findings: [],
    surface: { type: "changes", basis: "today", changes: evs.filter((e) => said(e)).slice(0, 20).map((e) => ({ kind: e.type, project_id: e.entity ? e.entity.id : null, text: said(e), tone: e.type === "PAYMENT_RECEIVED" || e.type === "PROJECT_READY" ? "gain" : "info" })) } };
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
  { const miss = unavailable(results, ["grace"]); if (miss) return miss; }
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
    : blockers.length ? "Held: " + blockers[0] : "On track.";
  /* Answer the question that was asked, about the piece by name: the stage
     for "what stage", the cause for "why", who and since when for "waiting",
     and otherwise the piece, its stage, its date and its balance. */
  const who = (p.client && p.client.name ? p.client.name + "'s " : "") + (p.name || p.id);
  const stageSay = "It's in " + String(p.stage).toLowerCase() + (p.due ? ", target " + p.due : "") + ".";
  const owed = p.outstanding > 0.005 ? money(p.outstanding) + " still owed." : "Paid in full.";
  const q = ctx.text || "";
  let summary;
  if (why) summary = who + ": " + (blockers.length ? blockers.join(" ") : "nothing in the records explains a hold, so the cause is unknown.") + (top ? " " + verdict : "");
  else if (/\b(waiting|waiting on|who are we)\b/i.test(q)) summary = waiting.length ? who + ": " + waiting.map((w) => "waiting on " + w.waiting_for_entity + (w.days !== null ? " for " + plural(w.days, "day") : "")).join("; ") + "." : who + ": nothing recorded as waiting.";
  else if (/\b(stage|where is it|status)\b/i.test(q)) summary = who + ". " + stageSay;
  else summary = who + ". " + stageSay + " " + owed + " " + verdict;
  return { summary: summary.replace(/\s+/g, " ").trim(), findings: mine,
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
          facts: [i.detail], unknowns: ["Whether the client has already been contacted some other way"], recommended_option: "APPROVE",
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
    summary: [done.length ? plural(done.length, "task") + " created" : "", pending.length ? plural(pending.length, "item") + " waiting on your approval" : "", refused.length ? plural(refused.length, "item") + " I couldn't act on" : ""].filter(Boolean).join("; ") + ". Nothing was sent to a client.",
    findings: [], surface: { type: "handled", done, pending, refused, verification: "Each item clears when the calculator's records change; I recheck at the next reading." } };
});

/* ------------------------------------------------ conversational follow-ups --- */
skill(meta("project_money", "Project Balance", ["ledger"], { purpose: "What one client owes on one commission.", inputs: ["entity"], sources: ["PAYMENT", "RECEIVABLE"] }), async (ctx) => {
  const p = ctx.entity;
  if (!p) return { status: RUN_STATUS.NEEDS_CLARIFICATION, summary: "Whose balance? Name the client or the commission.", findings: [], surface: { type: "text" } };
  const t = await ctx.read("ledger", "get_project", { id: p.id });
  ctx.delegations.push({ agent: "ledger", status: t.ok ? RUN_STATUS.OK : RUN_STATUS.FAILED, verified: !!t.ok, errors: t.ok ? [] : [t.failed_because] });
  if (!t.ok || !t.data) return calcDown(ctx);
  const x = t.data, who = (x.client && x.client.name) || "The client";
  const short = Math.max(0, x.capital - x.paid);
  const parts = [{ label: "Paid", amount: x.paid, sub: "recorded in the calculator" }, { label: "Outstanding", amount: x.outstanding, sub: "of " + money(x.value) }];
  if (short > 0.005 && ["Delivered", "Ready"].indexOf(x.stage) < 0) parts.push({ label: "Needed before production is funded", amount: short, sub: "production cost not yet covered" });
  const summary = x.outstanding > 0.005 ? who + " owes " + money(x.outstanding) + " on the " + (x.name || "commission") + ". " + money(x.paid) + " of " + money(x.value) + " is paid." : who + " has paid in full on the " + (x.name || "commission") + ".";
  return { summary, findings: [], surface: { type: "money_entity", entity: { id: x.id, name: x.name, client_name: who, stage: x.stage }, outstanding: x.outstanding, parts,
    evidence: { label: E.VERIFIED, source: "calculator", age: t.evidence && t.evidence.age } } };
});

skill(meta("delegate_draft", "Delegate a Draft", ["ace", "grace"], { purpose: "Have a specialist prepare a client message about the commission under discussion.", inputs: ["entity", "agent"], permissions: ["DRAFT"] }), async (ctx) => {
  const agentId = (ctx.intent && ctx.intent.agent) || "grace";
  const agent = ctx.registry.get(agentId);
  if (!agent) return { status: RUN_STATUS.OK, summary: "I don't have a specialist called " + agentId.toUpperCase() + ".", findings: [], surface: { type: "text" } };
  if (agent.status !== "ACTIVE")
    return { status: RUN_STATUS.NOT_CONNECTED, summary: agent.name + " isn't connected yet, so it can't take that on. GRACE or ACE can prepare client messages today.", findings: [],
      surface: { type: "not_connected", what: agent.name + " (" + agent.role + ")", detail: "Registered, not yet connected to any system." } };
  const p = ctx.entity;
  if (!p) return { status: RUN_STATUS.NEEDS_CLARIFICATION, summary: "Which client should " + agent.name + " write to?", findings: [], surface: { type: "text" } };
  const { findings } = await gather(ctx, ["grace", "ledger"]);
  const mine = findings.filter((f) => f.entity && f.entity.id === p.id).sort(byAttention);
  const DRAFTABLE = ["BALANCE_ON_FINISHED", "PRODUCTION_SHORT_MOVING", "PRODUCTION_UNFUNDED", "PAST_TARGET", "WAITING_LONG"];
  const item = mine.find((f) => DRAFTABLE.indexOf(f.code) >= 0) || null;
  const r = await ctx.gate.request({ agentId, tool: "draft_client_update", args: { item, project: p }, domain: "royal_t", run_id: ctx.run_id });
  ctx.delegations.push({ agent: agentId, status: r.status === "OK" ? RUN_STATUS.OK : RUN_STATUS.FAILED, verified: r.status === "OK", errors: r.status === "OK" ? [] : [r.reason || r.failed_because] });
  if (r.status === "DENIED")
    return { status: RUN_STATUS.OK, summary: agent.name + " doesn't write client messages. GRACE or ACE can.", findings: [], surface: { type: "text" } };
  if (r.status !== "OK" || !r.output || !r.output.ok)
    return { status: RUN_STATUS.FAILED, summary: agent.name + " could not prepare it: " + ((r.output && r.output.failed_because) || r.failed_because || "unknown") + ". Nothing was written.", findings: [], surface: { type: "text" } };
  const d = r.output.data, who = (p.client && p.client.name) || "the client";
  return { summary: agent.name + " prepared " + d.purpose + " for " + who + ". Nothing has been sent. Say \"send it\" when you're ready, and I'll put it in front of you for approval.",
    findings: [], pending_draft: { agent: agentId, project_id: p.id, client_name: who, client_id: p.client && p.client.id, purpose: d.purpose, body: d.body, item_id: item && item.id, amount: item && item.amount },
    surface: { type: "message_draft", to: who, purpose: d.purpose, body: d.body, by: agent.name, entity: { id: p.id } } };
});

skill(meta("send_pending", "Send the Draft", [], { purpose: "Send the message under discussion, through approval.", permissions: ["APPROVAL_REQUIRED"] }), async (ctx) => {
  const pd = ctx.conversation && ctx.conversation.pending_draft;
  if (!pd) return { status: RUN_STATUS.NEEDS_CLARIFICATION, summary: "Send what? There's no message ready in this conversation. Ask GRACE or ACE to prepare one first.", findings: [], surface: { type: "text" } };
  const r = await ctx.gate.request({ agentId: pd.agent, tool: "send_client_message", domain: "royal_t", run_id: ctx.run_id,
    args: { project_id: pd.project_id, draft: { purpose: pd.purpose, body: pd.body } },
    decision: { title: "Send " + pd.purpose + " to " + pd.client_name, description: pd.body, related_project_id: pd.project_id, related_client_id: pd.client_id,
      priority: P.P2, risk: R.YELLOW, recommended_option: "APPROVE", reasoning_summary: "Prepared by " + pd.agent.toUpperCase() + " from verified calculator state. It states no new date or price.",
      facts: ["Prepared in this conversation at your request."], unknowns: ["Whether the client has been contacted some other way"],
      financial_impact: pd.amount || null, expected_result: "The client receives this message.", source: "calculator", dedupe_key: "send:" + pd.project_id + ":" + stableHash([pd.purpose, pd.body]) } });
  if (r.status !== "PENDING_APPROVAL")
    return { status: RUN_STATUS.OK, summary: "I can't send that: " + (r.reason || r.status) + ". Nothing was sent.", findings: [], surface: { type: "text" } };
  if (r.already_decided)
    return { summary: "That exact message was already " + (["EXECUTED", "VERIFIED"].indexOf(r.decision.status) >= 0 ? "sent" : "approved") + ". I won't send it twice.",
      findings: [], pending_draft: null, surface: { type: "decision_pending", decision: r.decision } };
  const canSend = ctx.flags && ctx.flags.agent_external_send && ctx.messenger;
  return { summary: "That's a message to a client, so it needs your approval. It's in front of you now." +
      (canSend ? "" : " Sending isn't connected yet: when you approve, the approval is recorded and someone on the team sends it."),
    findings: [], pending_draft: null, surface: { type: "decision_pending", decision: r.decision } };
});

skill(meta("clear", "Clear", [], { purpose: "Return to a clean, ambient state and forget what this conversation was about.", permissions: [] }), async () =>
  ({ summary: "Cleared.", findings: [], pending_draft: null, surface: { type: "cleared" } }));
skill(meta("go_back", "Go Back", [], { purpose: "Return to the previous view.", permissions: [] }), async () =>
  ({ summary: "", findings: [], surface: { type: "back" } }));

/* --------------------------------------------------- outside the house --- */
skill(meta("personal", "Personal Intelligence", [], { purpose: "Tahir's own domains: wealth, calendar, personal tasks.", sources: ["APPOINTMENT"], realm: "PERSONAL" }), async (ctx) => {
  const ds = ctx.domains.filter((d) => d.realm === "PERSONAL");
  const connected = ds.filter((d) => d.status === "CONNECTED");
  return { status: connected.length ? RUN_STATUS.OK : RUN_STATUS.NOT_CONNECTED,
    summary: connected.length ? "Personal: " + connected.map((d) => d.name).join(", ") + " connected." : "Nothing personal is connected yet. I won't guess at your calendar, wealth or tasks, and your business records are never used here.",
    findings: [], surface: { type: "command_center", realm: "PERSONAL", level: connected.length ? "NOMINAL" : "OFFLINE",
      headline: connected.length ? "Personal systems online." : "Nothing personal is connected yet.",
      prompt: connected.length ? "What do you need?" : "Tell me what to connect first: calendar, tasks or wealth.",
      systems: ds.map((d) => ({ id: d.id, name: d.name, on: d.status === "CONNECTED", detail: d.status === "CONNECTED" ? "connected" : "not connected" })),
      connected: connected.length, total: ds.length, agents: [], decisions: 0, metrics: null, domains: ds } };
});
skill(meta("other_business", "Other Business Lines", [], { purpose: "Tahir & Co. and Gold Buy." }), async (ctx) => {
  const ds = ctx.domains.filter((d) => ["tahir_and_co", "gold_buy"].indexOf(d.id) >= 0);
  return { status: RUN_STATUS.NOT_CONNECTED, summary: ds.map((d) => d.name).join(" and ") + " are not connected to me. Their records are separate from Royal T and I won't mix them.",
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

/* ---------------------------------------------------------- fast path --- */
/* Greetings, "who are you", thanks and House definitions: answered from
   ROYAL's identity, the live connection state and the House language, with
   no model call.  Both realms; the Personal answers never touch business
   records. */
function liveState(ctx) {
  const d = (id) => (ctx.domains || []).find((x) => x.id === id);
  const on = (id) => !!(d(id) && d(id).status === "CONNECTED");
  const active = ctx.registry ? ctx.registry.specialists().filter((a) => a.status === "ACTIVE").map((a) => a.id) : [];
  return { calculator: on("royal_t"), research: on("world"), model: !!(ctx.provider && ctx.provider.status().status !== "NOT_CONNECTED"), specialists: active,
    personal_connected: (ctx.domains || []).filter((x) => x.realm === "PERSONAL" && x.status === "CONNECTED").map((x) => x.name) };
}
const fastMeta = (id, name, realm) => meta(id, name, [], { purpose: name + ", answered at once with no model call.", sources: [], realm });

skill(fastMeta("greeting", "Greeting", "BOTH"), async (ctx) => {
  let line = greetingLine(ctx.now);
  /* On the Business side, with the calculator connected, the greeting carries
     the one thing worth knowing: how much needs Tahir, from the records. */
  if (ctx.realm !== "PERSONAL" && liveState(ctx).calculator && SKILLS.what_needs_me) {
    const w = await SKILLS.what_needs_me.run(ctx);
    if (w && w.status !== RUN_STATUS.NOT_CONNECTED && w.summary) line += " " + w.summary;
  }
  return { summary: line, findings: [], surface: { type: "text" } };
});
skill(fastMeta("identity", "Who ROYAL is", "BOTH"), async (ctx) => ({ summary: describeSelf(liveState(ctx), { realm: ctx.realm || "BUSINESS" }), findings: [], surface: { type: "text" } }));
skill(fastMeta("thanks", "Thanks", "BOTH"), async () => ({ summary: "Anytime.", findings: [], surface: { type: "text" } }));
skill(fastMeta("house_term", "House language", "BUSINESS"), async (ctx) => {
  const q = definitionQuery(ctx.text);
  if (!q) return { summary: "I don't have a House definition for that.", findings: [], surface: { type: "text" } };
  const lines = q.terms.map((e) => e.say + " is " + e.def + "." + (e.confirm ? " You haven't confirmed " + e.confirm + " yet." : ""));
  for (const u of q.unknown) lines.push("I don't have a House definition for \u201c" + u + "\u201d.");
  return { summary: lines.join(" "), findings: [], surface: { type: "text", label: "VERIFIED_INTERNAL", sources: q.terms.map((e) => e.source) } };
});

/* --------------------------------------------------- agent activity --- */
/* "What did each Bot do today?", "What did ACE do?", "What are you working
   on?": answered from ROYAL's own records (core/agent_ledger.js), never by
   asking the bots to vouch for themselves and never by searching the web.
   Each specialist is read on its own; one that cannot be read is said so
   and the rest are still reported.  A Grok Bot's own posts are REPORTED,
   not verified. */
const plainText = (s, n = 140) => String(s || "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_#>|]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
const countWords = (n, one, many) => n + " " + (n === 1 ? one : many);

export function agentsNamed(text) {
  const t = String(text || "");
  const ids = [];
  for (const [id, re] of [["ace", /\bace\b/i], ["grace", /\bgrace\b/i], ["ledger", /\bledger\b/i], ["forge", /\bforge\b/i], ["house", /\bHOUSE\b|\bhouse (bot|agent)\b/]]) if (re.test(t)) ids.push(id);
  return ids;
}

function agentLine(a, objectiveWords) {
  if (a.error) return a.name + ": I couldn't read its record (" + a.error + ").";
  const parts = [];
  const n = a.native;
  if (n && n.runs) {
    const kinds = Object.entries(n.objectives || {}).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, c]) => objectiveWords(k) + (c > 1 ? " (" + c + ")" : "")).join(", ");
    const bad = [n.timed_out ? countWords(n.timed_out, "timed out", "timed out") : "", n.failed ? n.failed + " failed" : ""].filter(Boolean).join(", ");
    parts.push("worked " + countWords(n.runs, "request", "requests") + " for you: " + kinds + (bad ? "; " + bad : "; all finished"));
  }
  const d = a.delegated;
  if (d && d.length) {
    const by = (s) => d.filter((t) => t.status === s).length;
    const bits = [["REPORTED_COMPLETE", "reported done"], ["VERIFIED_COMPLETE", "verified done"], ["IN_PROGRESS", "in progress"], ["ASSIGNED", "assigned"], ["WAITING", "waiting"], ["FAILED", "failed"], ["CANCELLED", "cancelled"]]
      .map(([s, w]) => (by(s) ? by(s) + " " + w : "")).filter(Boolean).join(", ");
    parts.push("of " + countWords(d.length, "task", "tasks") + " I gave its Grok Bot: " + bits);
  }
  if (a.feed && a.feed.error) parts.push("I couldn't read its Grok Bot's feed (" + a.feed.error + ")");
  else if (a.feed && a.feed.length) {
    const last = a.feed[a.feed.length - 1];
    parts.push("its Grok Bot posted " + countWords(a.feed.length, "update", "updates") + " (reported, not verified); latest: “" + plainText(last.content_markdown) + "”");
  }
  if (!parts.length) {
    const why = a.id === "house" ? " HOUSE has no native runtime yet" + (a.bot ? ", and its Grok Bot is " + String(a.bot.connection).toLowerCase().replace(/_/g, " ") : ", and no Grok Bot is set up for it") + "." : "";
    return a.name + ": nothing recorded today." + why;
  }
  return a.name + " " + parts.join("; ") + ".";
}

skill(meta("agent_activity", "Agent daily activity", ALL, { purpose: "What each specialist worked on today, from ROYAL's own records.", sources: [] }), async (ctx) => {
  if (!ctx.ledger) return { status: RUN_STATUS.NOT_CONNECTED, summary: "My activity record isn't available on this server.", findings: [], surface: { type: "text" } };
  const named = agentsNamed(ctx.text);
  const review = await ctx.ledger.review({ agents: named.length ? named : undefined, tasks: ctx.tasks, bridge: ctx.bridge, realm: "BUSINESS" });
  const lines = review.agents.map((a) => agentLine(a, objectiveWordsFor));
  const failed = review.agents.flatMap((a) => (a.delegated || []).filter((t) => t.status === "FAILED").map((t) => a.name + ": " + plainText(t.objective, 80)));
  const unreadable = review.agents.filter((a) => a.error || (a.feed && a.feed.error)).map((a) => a.name);
  const reported = review.agents.filter((a) => a.feed && a.feed.length).map((a) => a.name);
  /* "Why didn't GRACE finish that?": the recorded reason for each run or
     task that ended badly today, or plainly that nothing did. */
  if (/\bwhy\b.*\b(didn'?t|did not|hasn'?t|has not|not|fail|stop|finish)/i.test(ctx.text || "")) {
    const REASON = { TIMEOUT: "it ran past its deadline", ERROR: "it hit an error", INVALID_RESULT: "it returned something I couldn't validate", NOT_CONNECTED: "it isn't connected" };
    const why = review.agents.flatMap((a) => ((a.native && a.native.recent) || []).filter((x) => x.status !== "OK" && x.status !== "PARTIAL")
      .map((x) => a.name + " on " + objectiveWordsFor(x.skill) + ": " + (REASON[x.reason] || "it failed") + (x.error && x.reason === "ERROR" ? " (" + plainText(x.error, 80) + ")" : ""))
      .concat((a.delegated || []).filter((t) => ["FAILED", "TIMED_OUT", "CANCELLED"].indexOf(t.status) >= 0)
        .map((t) => a.name + "'s Grok Bot on “" + plainText(t.objective, 60) + "”: " + String(t.fail_reason || t.cancel_reason || t.status).toLowerCase().replace(/_/g, " "))));
    const who = named.length ? review.agents.map((a) => a.name).join(" and ") : "my team";
    return { status: RUN_STATUS.OK, summary: why.length ? "Here's what didn't finish today, from the record. " + why.slice(0, 6).join(". ") + "." : "Nothing " + who + " was given today failed or was left unfinished, by the record.",
      findings: [], surface: { type: "text", label: "VERIFIED_INTERNAL" } };
  }
  const head = named.length === 1 ? "I checked " + review.agents[0].name + "'s record for today." : "I checked today's record for " + (named.length ? "them" : "all five") + ".";
  const tail = (failed.length ? " Needs you: " + failed.length + " delegated " + (failed.length === 1 ? "task" : "tasks") + " failed." : "") +
    (reported.length ? " What " + reported.join(" and ") + " posted is their own report; I haven't verified it." : "") +
    (unreadable.length ? " I couldn't read " + unreadable.join(" and ") + " fully, so that part is missing." : "");
  return { status: unreadable.length ? RUN_STATUS.PARTIAL : RUN_STATUS.OK, summary: head + " " + lines.join(" ") + tail, findings: [], surface: { type: "text", label: "VERIFIED_INTERNAL" },
    data: { day: review.day, lines, agents: review.agents.map((a) => ({ id: a.id, runs: a.native ? a.native.runs : 0, tasks: (a.delegated || []).length, reported: a.feed && a.feed.length ? a.feed.length : 0 })) } };
});

/* "What are you working on?": the delegated work that is actually open. */
skill(meta("active_work", "Active work", [], { purpose: "What is running, waiting or failed right now, from the task record.", sources: [] }), async (ctx) => {
  if (!ctx.tasks) return { summary: "I'm not running anything in the background.", findings: [], surface: { type: "text" } };
  const all = (await ctx.tasks.list()).filter((t) => t.adapter !== "native");   /* native runs finish inside the answer that asked for them */
  const live = (ctx.running ? ctx.running() : []).filter((x) => x.run_id !== ctx.run_id);
  const open = all.filter((t) => ["ASSIGNED", "IN_PROGRESS", "WAITING"].indexOf(t.status) >= 0);
  const dayAgo = (ctx.now || Date.now()) - 86400000;
  const recent = all.filter((t) => t.created_at >= dayAgo && ["REPORTED_COMPLETE", "VERIFIED_COMPLETE", "PARTIAL", "TIMED_OUT", "FAILED"].indexOf(t.status) >= 0);
  if (!open.length && !recent.length && !live.length) return { summary: "Nothing is running in the background right now. Everything I've been asked today has been answered.", findings: [], surface: { type: "text" } };
  const say = (t) => t.agent.toUpperCase() + " on “" + plainText(t.objective, 70) + "”" + (t.status === "WAITING" ? " (waiting on someone)" : "") + (t.overdue ? " (past its deadline)" : "");
  const parts = [];
  if (live.length) parts.push(live.map((x) => x.agent.toUpperCase() + " is working on " + x.objective).join(", ") + " right now.");
  if (open.length) parts.push("I have " + open.map(say).join(", ") + " in progress.");
  const done = recent.filter((t) => ["FAILED", "TIMED_OUT"].indexOf(t.status) < 0), bad = recent.filter((t) => ["FAILED", "TIMED_OUT"].indexOf(t.status) >= 0);
  if (done.length) parts.push(countWords(done.length, "task", "tasks") + " came back in the last day (reported, not verified).");
  if (bad.length) parts.push(countWords(bad.length, "task", "tasks") + " failed: " + bad.map(say).join(", ") + ".");
  return { summary: parts.join(" "), findings: [], surface: { type: "text" } };
});

/* "Diagnose yourself", "What systems are actually working?" */
skill(meta("self_diagnostic", "Self-diagnostic", [], { purpose: "Every part of ROYAL with its real state and the evidence for it.", sources: [] }), async (ctx) => {
  if (!ctx.diagnostics) return { status: RUN_STATUS.NOT_CONNECTED, summary: "My diagnostics aren't available here.", findings: [], surface: { type: "text" } };
  const d = await ctx.diagnostics();
  const by = (s) => d.filter((x) => x.state === s);
  const name = (x) => x.system + " (" + x.evidence + ")";
  const parts = ["I checked " + d.length + " parts of myself."];
  if (by("HEALTHY").length) parts.push("Working: " + by("HEALTHY").map((x) => x.system).join(", ") + ".");
  if (by("DEGRADED").length) parts.push("Degraded: " + by("DEGRADED").map(name).join("; ") + ".");
  if (by("FAILED").length) parts.push("Failed: " + by("FAILED").map(name).join("; ") + ".");
  if (by("NOT_CONFIGURED").length) parts.push("Not set up: " + by("NOT_CONFIGURED").map(name).join("; ") + ".");
  return { status: by("FAILED").length ? RUN_STATUS.PARTIAL : RUN_STATUS.OK, summary: parts.join(" "), findings: [], surface: { type: "text", label: "VERIFIED_INTERNAL" }, data: { checks: d } };
});

/* ------------------------------------------------------ cash analysis --- */
/* "Why have we been tight on cash?" from the House's real numbers: LEDGER's
   read of the projects and the calculator's own treasury (its runway is its
   calculation; ROYAL never recomputes it).  Fact, analysis and
   recommendation are kept apart, and the limits of what ROYAL can see are
   said: no bank feed, no expenses, no history by month. */
skill(meta("cash_analysis", "Cash position and pressure", ["ledger"], { purpose: "Where the cash is, and what is holding it, from the calculator's money records." }), async (ctx) => {
  const { results } = await gather(ctx, ["ledger"]);
  if (notConnected(results)) return calcDown(ctx);
  const l = results.ledger && results.ledger.data;
  if (!l) return { status: RUN_STATUS.FAILED, summary: "LEDGER didn't return the money record, so I can't answer that yet.", findings: [], surface: { type: "text" } };
  const tr = l.treasury || null;
  const finished = l.debtors.filter((d) => d.finished).reduce((a, d) => a + d.outstanding, 0);
  const unfundedProd = l.unfunded;
  const lateBills = tr && tr.inbox ? tr.inbox.filter((i) => i.sec === "payables") : [];
  const fact = tr
    ? "The calculator shows " + money(tr.available) + " available, " + money(tr.receivable) + " owed to us and " + money(tr.payable) + " we owe vendors" + (tr.runway_days != null ? ", with " + tr.runway_days + " days of runway by its calculation" : "") + "."
    : money(l.receivable) + " is owed to us across " + plural(l.debtors.length, "commission") + ". The calculator didn't send its treasury, so I can't see available cash.";
  const analysis = [];
  if (finished > 0) analysis.push(money(finished) + " of what we're owed is on finished pieces, so it's collectable now without more work");
  if (unfundedProd > 0) analysis.push(money(unfundedProd) + " of production is running ahead of what clients have paid toward it");
  if (lateBills.length) analysis.push(plural(lateBills.length, "vendor bill") + " " + (lateBills.length === 1 ? "is" : "are") + " overdue (" + lateBills.map((b) => b.title.replace(/^Overdue to /, "") + " " + money(b.amount)).join(", ") + ")");
  const rec = finished > 0 ? "If cash is the priority, I'd collect the finished-piece balances first: they need no more work." : unfundedProd > 0 ? "If cash is the priority, I'd collect toward production that's running ahead before starting more." : null;
  const limits = "I can't see the bank, expenses or month-by-month history, so this is the position now, not the full story of why it got tight.";
  /* Where the record disagrees with itself, say so rather than pick a side. */
  const latest = ctx.connector ? await ctx.connector.latest() : null;
  const money_conflicts = latest ? congruence(latest.snapshot).issues.filter((i) => i.kind === "SOURCE_CONFLICT" && /RECEIVABLE|PAYABLE/.test(i.code)) : [];
  const nc = money_conflicts.length;
  const conflictLine = nc ? (nc === 1 ? "One thing doesn't add up: " : (nc === 2 ? "Two" : nc) + " things don't add up: ") +
    money_conflicts.map((i) => i.text).join(" ") + " I haven't picked one side; the calculator's records should be checked." : "";
  return { status: RUN_STATUS.OK, summary: [fact, analysis.length ? "What it means: " + analysis.join("; ") + "." : "", conflictLine, rec ? "My recommendation: " + rec.replace(/^If/, "if") : "", limits].filter(Boolean).join(" "),
    findings: (results.ledger.findings || []).slice(0, 8), surface: { type: "text", label: "VERIFIED" } };
});
