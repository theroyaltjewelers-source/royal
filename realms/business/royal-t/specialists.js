/* ACE, GRACE, LEDGER and FORGE for The House of Royal T.

   Each specialist reads the calculator's verified state through the read
   tools and returns a structured result.  Where the calculator has already
   judged something (its attention list, its Treasury exception queue, its
   project health), the specialist uses that judgement by its machine code
   and adds only priority, risk, ownership and what Tahir would have to do.
   Where ROYAL adds its own reading (a lead that looks stalled, a dependency
   that has waited too long), the finding is labelled INFERENCE. */

import { PRIORITY as P, RISK as R, NEED as N, EVIDENCE as E, WAITING_TYPE as W, RUN_STATUS, COMMITMENT_STATUS as CS } from "../../../core/enums.js";
import { agentResult } from "../../../core/result.js";
import { parseDate, daysBetween, money, plural, DAY, stableHash } from "../../../core/util.js";

/* Who owns what by default.  [TAHIR TO CONFIRM]: staff assignments.  Until
   then every item resolves to one named owner, Tahir, rather than to a
   shared nobody. */
export const DEFAULT_OWNERS = { collections: "Tahir", production: "Tahir", client_updates: "Tahir", sales: "Tahir", finance: "Tahir", systems: "Tahir" };

/* The calculator's attention codes, and what each means for Tahir. */
export const ATTENTION_CODES = {
  PRODUCTION_SHORT_MOVING: { agent: "ledger", priority: P.P1, risk: R.RED, need: N.DO, owner: "collections",
    title: "Production is moving without full funding", verify: "Payment recorded in the calculator" },
  PRODUCTION_UNFUNDED:     { agent: "ledger", priority: P.P2, risk: R.YELLOW, need: N.DO, owner: "collections",
    title: "Production cannot be funded yet", verify: "Payment recorded in the calculator" },
  BALANCE_ON_FINISHED:     { agent: "ledger", priority: P.P1, risk: R.ORANGE, need: N.DO, owner: "collections",
    title: "Balance outstanding on a finished piece", verify: "Final payment recorded in the calculator" },
  BELOW_MARGIN_FLOOR:      { agent: "ledger", priority: P.P2, risk: R.YELLOW, need: N.KNOW, owner: "finance",
    title: "Quoted below the margin floor", verify: "Requote in the calculator" },
  ENHANCEMENT_REQUESTED:   { agent: "ace", priority: P.P1, risk: R.YELLOW, need: N.DECIDE, owner: "sales",
    title: "Client asked for an enhancement that has no rate", verify: "Rate set in the proposal" },
  NO_CLIENT_EMAIL:         { agent: "ace", priority: P.P3, risk: R.YELLOW, need: N.DELEGATE, owner: "sales",
    title: "No client email on file", verify: "Email saved on the client record" },
  NO_COVER_IMAGE:          { agent: "grace", priority: P.P3, risk: R.GREEN, need: N.NONE, owner: "client_updates",
    title: "Proposal has no cover image", verify: "Cover image set" },
  PAST_TARGET:             { agent: "grace", priority: P.P1, risk: R.RED, need: N.DECIDE, owner: "production",
    title: "Past its target date", verify: "Stage moves to Ready, or a new date is agreed with the client" },
};

const TREASURY_SEV = { critical: [P.P1, R.RED], warning: [P.P2, R.ORANGE], watch: [P.P3, R.YELLOW] };

/* Waiting that a stage implies, and how long before it deserves a look.
   Thresholds are ROYAL defaults. [TAHIR TO CONFIRM] */
export const STAGE_WAIT = {
  "CAD":               { type: W.CAD, what: "the CAD", days: 7, owner: "production" },
  "Awaiting approval": { type: W.CLIENT, what: "the client's design approval", days: 5, owner: "client_updates" },
  "Deposit due":       { type: W.PAYMENT, what: "the client's deposit", days: 7, owner: "collections" },
  "Production":        { type: W.MANUFACTURER, what: "the manufacturer", days: 21, owner: "production" },
  "Quality control":   { type: W.STAFF, what: "quality control", days: 3, owner: "production" },
  "Balance due":       { type: W.PAYMENT, what: "the client's balance", days: 7, owner: "collections" },
  "Ready":             { type: W.CLIENT, what: "the client to collect", days: 14, owner: "client_updates" },
};

function projectEntity(p) { return { type: "project", id: p.id, name: p.name || "Untitled", client_name: (p.client && p.client.name) || "Unnamed client", client_id: p.client && p.client.id || null, stage: p.stage }; }
function label(p) { return ((p.client && p.client.name) || "Unnamed client") + ", " + (p.name || "untitled"); }

function item(o) {
  return {
    id: o.id || ("itm_" + stableHash([o.code, o.entity && o.entity.id, o.key || ""])),
    kind: o.kind, code: o.code, domain: "royal_t", agent: o.agent,
    title: o.title, detail: o.detail || "", entity: o.entity || null,
    priority: o.priority, risk: o.risk, need: o.need, owner: o.owner || null,
    next_action: o.next_action || null, due_at: o.due_at || null, verification: o.verification || null,
    amount: o.amount === undefined ? null : o.amount,
    evidence: o.evidence, link: o.link || null,
  };
}

function ev(tool, label = E.VERIFIED, note) {
  return { label, source: label === E.VERIFIED ? "calculator" : "royal", verified_at: tool.evidence && tool.evidence.verified_at, freshness: tool.evidence && tool.evidence.freshness, note: note || null };
}

/* ------------------------------------------------------------------ GRACE -- */
export async function grace(ctx) {
  const t = await ctx.read("grace", "get_active_projects");
  if (!t.ok) return notConnected("grace", ctx, t);
  const owners = ctx.owners, now = ctx.now, findings = [], waiting = [], commitments = [];
  for (const p of t.data) {
    const ent = projectEntity(p);
    (p.attention || []).filter((a) => ATTENTION_CODES[a.code] && ATTENTION_CODES[a.code].agent === "grace").forEach((a) => {
      const m = ATTENTION_CODES[a.code];
      const late = a.code === "PAST_TARGET" && p.due ? daysBetween(parseDate(p.due), now) : null;
      findings.push(item({ kind: a.code === "PAST_TARGET" ? "COMMITMENT" : "RISK", code: a.code, agent: "grace",
        title: late ? "Past its target date by " + plural(late, "day") : m.title, detail: a.why,
        entity: ent, priority: m.priority, risk: late !== null && late > 7 ? R.BLACK : m.risk, need: m.need,
        owner: owners[m.owner], next_action: a.code === "PAST_TARGET" ? "Confirm the real finish date with the manufacturer, then tell the client." : "Set a cover image.",
        verification: m.verify, evidence: ev(t), link: { project: p.id, section: a.sec } }));
    });
    /* The target date is the House's promise to the client. */
    const due = parseDate(p.due);
    if (due) {
      const days = daysBetween(now, due), done = ["Ready", "Delivered"].indexOf(p.stage) >= 0;
      const status = done ? CS.REPORTED_COMPLETE : days < 0 ? CS.OVERDUE : days <= 7 ? CS.DUE_SOON : CS.OPEN;
      commitments.push({ id: "cmt_" + stableHash(["target", p.id, p.due]), type: "DELIVERY_DATE", made_by: "The House", made_to: ent.client_name,
        client_id: ent.client_id, project_id: p.id, description: "Deliver " + (p.name || "the piece") + " by " + p.due, due_at: due, owner: owners.production,
        status, source_reference: "calculator: project target date", verification_required: "Stage reaches Ready", evidence: ev(t) });
      if (!done && days >= 0 && days <= 7 && ["Quality control"].indexOf(p.stage) < 0)
        findings.push(item({ kind: "COMMITMENT", code: "DUE_SOON", agent: "grace", title: days === 0 ? "Due today" : "Due in " + plural(days, "day"),
          detail: "In " + p.stage + " with a target of " + p.due + ".", entity: ent, priority: days <= 2 ? P.P1 : P.P2,
          risk: days <= 2 && ["Production", "CAD", "Design"].indexOf(p.stage) >= 0 ? R.ORANGE : R.YELLOW, need: days <= 2 ? N.KNOW : N.MONITOR,
          owner: owners.production, due_at: due, next_action: "Confirm the piece will be ready, or reset the date with the client before it passes.",
          verification: "Stage reaches Ready", evidence: ev(t, E.INFERENCE, "Risk judged from stage and days remaining."), link: { project: p.id, section: "production" } }));
    }
    const w = STAGE_WAIT[p.stage];
    if (w) {
      const since = parseDate(p.stage_since) || parseDate(p.updated_at);
      const waited = since ? daysBetween(since, now) : null;
      waiting.push({ id: "wt_" + stableHash([p.id, p.stage]), waiting_for_type: w.type, waiting_for_entity: w.what, reason: p.stage,
        project_id: p.id, entity: ent, owner: owners[w.owner], waiting_since: since, days: waited,
        expected_by: since ? since + w.days * DAY : null, escalation_threshold_days: w.days,
        overdue: waited !== null && waited > w.days, since_basis: p.stage_since ? "stage change" : "last edit",
        evidence: ev(t, p.stage_since ? E.VERIFIED : E.INFERENCE, p.stage_since ? null : "Waiting time measured from the record's last edit.") });
      if (waited !== null && waited > w.days * 2 && w.type !== W.PAYMENT)
        findings.push(item({ kind: "WAITING", code: "WAITING_LONG", agent: "grace", title: "Waiting on " + w.what + " for " + plural(waited, "day"),
          detail: "In " + p.stage + " since " + new Date(since).toISOString().slice(0, 10) + ".",
          entity: ent, priority: P.P2, risk: R.YELLOW, need: N.DELEGATE, owner: owners[w.owner],
          next_action: "Chase " + w.what + ".", evidence: ev(t, E.INFERENCE, "Measured from " + (p.stage_since ? "the stage change" : "the last edit") + "."),
          link: { project: p.id, section: "production" } }));
    }
  }
  const prod = t.data.filter((p) => ["CAD", "Awaiting approval", "Deposit due", "Production", "Quality control", "Ready"].indexOf(p.stage) >= 0);
  return agentResult({ agent: "grace", run_id: ctx.run_id, findings, sources: [t.evidence],
    summary: prod.length ? plural(prod.length, "commission") + " in production or awaiting the client." : "No commissions are in production.",
    data: { waiting, commitments, in_production: prod.map(projectEntity) } });
}

/* ----------------------------------------------------------------- LEDGER -- */
export async function ledger(ctx) {
  const t = await ctx.read("ledger", "get_active_projects");
  if (!t.ok) return notConnected("ledger", ctx, t);
  const tr = await ctx.read("ledger", "get_treasury");
  const owners = ctx.owners, findings = [];
  let receivable = 0, collected = 0, contract = 0, unfunded = 0;
  const debtors = [];
  for (const p of t.data) {
    const ent = projectEntity(p);
    receivable += Math.max(0, p.outstanding); collected += p.paid; contract += p.value; unfunded += Math.max(0, p.capital - p.paid);
    if (p.outstanding > 0.005) debtors.push({ entity: ent, outstanding: p.outstanding, stage: p.stage, finished: ["Ready", "Delivered", "Quality control"].indexOf(p.stage) >= 0 });
    (p.attention || []).filter((a) => ATTENTION_CODES[a.code] && ATTENTION_CODES[a.code].agent === "ledger").forEach((a) => {
      const m = ATTENTION_CODES[a.code];
      const amount = a.code === "BALANCE_ON_FINISHED" ? p.outstanding : (a.code.indexOf("PRODUCTION") === 0 ? Math.max(0, p.capital - p.paid) : null);
      findings.push(item({ kind: "RECEIVABLE", code: a.code, agent: "ledger", title: m.title, detail: a.why, entity: ent,
        priority: m.priority, risk: m.risk, need: m.need, owner: owners[m.owner], amount,
        next_action: a.code === "BELOW_MARGIN_FLOOR" ? "Review the quote before it goes further." : "Collect " + money(amount) + ".",
        verification: m.verify, evidence: ev(t), link: { project: p.id, section: a.sec } }));
    });
  }
  if (tr.ok && tr.data) {
    (tr.data.inbox || []).forEach((i) => {
      const [pri, risk] = TREASURY_SEV[i.sev] || [P.P3, R.YELLOW];
      const code = "TREASURY_" + String(i.key).split(":")[0].toUpperCase().replace(/-/g, "_");
      findings.push(item({ kind: "TREASURY", code, key: i.key, agent: "ledger", title: i.title, detail: i.desc, priority: pri, risk,
        need: code === "TREASURY_CAP_LATE" ? N.DO : pri === P.P1 ? N.DECIDE : N.KNOW, owner: owners.finance, amount: i.amount,
        next_action: code === "TREASURY_BILL_LATE" ? "Pay it or agree a new date with the vendor." : code === "TREASURY_CAP_LATE" ? "Repay, or give the lender a new date yourself." : null,
        evidence: ev(tr), link: { tab: "treasury", section: i.sec } }));
    });
  }
  debtors.sort((a, b) => b.outstanding - a.outstanding);
  const treasury = tr.ok ? tr.data : null;
  return agentResult({ agent: "ledger", run_id: ctx.run_id, findings, sources: [t.evidence].concat(tr.ok ? [tr.evidence] : []),
    summary: money(receivable) + " outstanding across " + plural(debtors.length, "commission") + "; " + money(collected) + " collected on live work.",
    data: { receivable, collected, contract, unfunded, debtors, treasury } });
}

/* -------------------------------------------------------------------- ACE -- */
export async function ace(ctx) {
  const t = await ctx.read("ace", "get_active_projects");
  if (!t.ok) return notConnected("ace", ctx, t);
  const owners = ctx.owners, now = ctx.now, findings = [];
  const pipeline = t.data.filter((p) => ["Inquiry", "Design"].indexOf(p.stage) >= 0);
  for (const p of t.data) {
    const ent = projectEntity(p);
    (p.attention || []).filter((a) => ATTENTION_CODES[a.code] && ATTENTION_CODES[a.code].agent === "ace").forEach((a) => {
      const m = ATTENTION_CODES[a.code];
      findings.push(item({ kind: "SALES", code: a.code, agent: "ace", title: m.title, detail: a.why, entity: ent,
        priority: m.priority, risk: m.risk, need: m.need, owner: owners[m.owner],
        next_action: a.code === "ENHANCEMENT_REQUESTED" ? "Set a rate so it can be added to the proposal." : "Get the client's email.",
        verification: m.verify, evidence: ev(t), link: { project: p.id, section: a.sec } }));
    });
  }
  pipeline.forEach((p) => {
    const last = parseDate(p.last_activity_at) || parseDate(p.updated_at);
    const idle = last ? daysBetween(last, now) : null;
    if (idle !== null && idle > 14)
      findings.push(item({ kind: "SALES", code: "LEAD_STALLED", agent: "ace", title: "Lead may have stalled",
        detail: "At " + p.stage + " with no change for " + plural(idle, "day") + ".", entity: projectEntity(p),
        priority: P.P2, risk: R.YELLOW, need: N.DELEGATE, owner: owners.sales, next_action: "Follow up, or close the lead.",
        evidence: ev(t, E.INFERENCE, "Judged from time since the last change."), link: { project: p.id, section: "overview" } }));
  });
  return agentResult({ agent: "ace", run_id: ctx.run_id, findings, sources: [t.evidence],
    summary: pipeline.length ? plural(pipeline.length, "open lead") + " at inquiry or design." : "No open leads at inquiry or design.",
    data: { pipeline: pipeline.map((p) => ({ ...projectEntity(p), value: p.value, updated_at: p.updated_at })) } });
}

/* ------------------------------------------------------------------ FORGE -- */
export async function forge(ctx) {
  const findings = [];
  const st = await ctx.connector.status(ctx.now);
  if (!st.connected)
    findings.push(item({ kind: "SYSTEM", code: "CALCULATOR_NOT_CONNECTED", agent: "forge", title: "ROYAL cannot see the calculator",
      detail: "No calculator state has reached ROYAL, so nothing about projects, clients or money can be verified.",
      priority: P.P2, risk: R.ORANGE, need: N.DO, owner: ctx.owners.systems,
      next_action: "Open the calculator while signed in. It sends its state to ROYAL automatically.",
      evidence: { label: E.VERIFIED, source: "royal.health", verified_at: ctx.now } }));
  else {
    if (st.freshness === "STALE")
      findings.push(item({ kind: "SYSTEM", code: "CALCULATOR_STALE", agent: "forge", title: "Calculator data is stale",
        detail: "What ROYAL knows was " + st.age + ". Answers are labelled with that age.", priority: P.P3, risk: R.YELLOW, need: N.KNOW,
        owner: ctx.owners.systems, next_action: "Open the calculator to refresh.", evidence: { label: E.VERIFIED, source: "royal.health", verified_at: ctx.now } }));
    if (st.partial)
      findings.push(item({ kind: "SYSTEM", code: "CALCULATOR_PARTIAL", agent: "forge", title: "Calculator loaded only part of the records",
        detail: (st.partial_notes || []).join(" ") || "A load came back at its limit.", priority: P.P2, risk: R.ORANGE, need: N.KNOW,
        owner: ctx.owners.systems, evidence: { label: E.VERIFIED, source: "calculator", verified_at: st.verified_at } }));
    const snap = await ctx.connector.latest();
    const conflicts = (snap && snap.snapshot.meta && snap.snapshot.meta.save_conflicts) || 0;
    if (conflicts)
      findings.push(item({ kind: "DATA", code: "SAVE_CONFLICT", agent: "forge", title: plural(conflicts, "save conflict") + " waiting in the calculator",
        detail: "Two edits to the same record collided. The calculator is holding both versions until someone chooses.",
        priority: P.P1, risk: R.ORANGE, need: N.DECIDE, owner: ctx.owners.systems, next_action: "Open Today in the calculator and resolve the conflict.",
        evidence: { label: E.VERIFIED, source: "calculator", verified_at: st.verified_at }, link: { tab: "dash" } }));
  }
  return agentResult({ agent: "forge", run_id: ctx.run_id, findings, sources: [{ label: E.VERIFIED, source: "royal.health", verified_at: ctx.now }],
    summary: st.connected ? "Calculator connected, " + st.age + "." : "Calculator not connected.",
    data: { calculator: st, provider: ctx.provider ? ctx.provider.status() : null, health: ctx.health ? ctx.health.all() : [] } });
}

function notConnected(agent, ctx, t) {
  return agentResult({ agent, run_id: ctx.run_id, status: RUN_STATUS.NOT_CONNECTED, findings: [],
    summary: agent.toUpperCase() + " could not reach the calculator. " + (t.impact || ""), sources: [],
    unresolved_questions: [t.failed_because] });
}

export const SPECIALISTS = { ace, grace, ledger, forge };
