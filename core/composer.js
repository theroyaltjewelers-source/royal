/* The UI Composer.  Turns a structured ROYAL result into a presentation spec
   built only from the primitive vocabulary in web/js/schema.js.

   The spec is composed here, on the server, deterministically from verified
   results.  A language model never writes a spec: the most a model's answer
   can become is a STATEMENT primitive carrying its text and an INFERENCE
   label.  Every spec is validated before it leaves the server; a primitive
   that fails its schema is dropped and the rejection is reported. */

import { validateSpec, SPEC_VERSION } from "../web/js/schema.js";

const KIND = { RECEIVABLE: "RECEIVABLE_OBJECT", COMMITMENT: "COMMITMENT_OBJECT", WAITING: "WAITING_OBJECT", SALES: "LEAD_OBJECT",
  RISK: "RISK_OBJECT", TREASURY: "RISK_OBJECT", SYSTEM: "RISK_OBJECT", DATA: "RISK_OBJECT", DECISION: "RISK_OBJECT" };

const s = (v, n = 2000) => (v === undefined || v === null ? undefined : String(v).slice(0, n));
const num = (v) => (typeof v === "number" && isFinite(v) ? v : undefined);
const clean = (o) => { const r = {}; for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") r[k] = v; return r; };

function evidence(e) {
  if (!e || !e.label) return undefined;
  return clean({ label: s(e.label, 40), source: s(e.source, 80), age: s(e.age, 80), note: s(e.note, 300) });
}
function entity(e) {
  if (!e) return undefined;
  return clean({ type: s(e.type || "project", 20), id: s(e.id, 80), name: s(e.name, 200), client_name: s(e.client_name, 200), client_id: s(e.client_id, 80), stage: s(e.stage, 60) });
}
function item(i) {
  return clean({ id: s(i.id, 120), title: s(i.title, 300) || "Untitled", detail: s(i.detail, 1000), priority: s(i.priority, 4), risk: s(i.risk, 8),
    need: s(i.need, 12), owner: s(i.owner, 120), next_action: s(i.next_action, 500), amount: num(i.amount), entity: entity(i.entity),
    evidence: evidence(i.evidence), code: s(i.code, 60) });
}
const itemPrim = (i) => ({ type: KIND[i.kind] || "RISK_OBJECT", data: item(i) });

const REV = { REVERSIBLE: "Reversible", PARTIALLY_REVERSIBLE: "Partly reversible", DIFFICULT_TO_REVERSE: "Hard to reverse", IRREVERSIBLE: "Cannot be undone" };
export function decisionPrim(d) {
  const dr = d.action && d.action.args && d.action.args.draft;
  const draft = dr && dr.body ? (dr.subject ? "Subject: " + dr.subject + "\n\n" : "") + dr.body : undefined;
  const exec = d.execution ? (d.execution.result === "NO_EXECUTOR" ? "Approved and recorded. " + (d.execution.next_action || "") : d.execution.result + (d.execution.failed_because ? ": " + d.execution.failed_because : "")) : undefined;
  return { type: "DECISION_OBJECT", data: clean({ id: s(d.id, 80), type: s(d.type, 40), title: s(d.title, 300), status: s(d.status, 20), priority: s(d.priority, 4), risk: s(d.risk, 8),
    why: s(d.reasoning_summary || d.description, 1000), requested_by: s(String(d.requested_by_agent || "").toUpperCase(), 40), source: s(d.source, 80),
    expected_result: s(d.expected_result, 500), financial_impact: num(d.financial_impact), reversibility: s(REV[d.reversibility] || d.reversibility, 40),
    deadline: d.deadline ? s(new Date(d.deadline).toISOString().slice(0, 10), 40) : undefined,
    facts: (d.facts || []).slice(0, 10).map((x) => s(x, 500)), unknowns: (d.unknowns || []).slice(0, 10).map((x) => s(x, 300)),
    draft: s(draft, 4000), execution: s(exec, 500),
    if_we_wait: d.status === "OPEN" ? "Nothing is sent or changed until you decide." : undefined }) };
}

function money(v) { return "$" + Math.round(v || 0).toLocaleString("en-US"); }

function hostName(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return ""; } }
function sourcePrim(x) {
  return clean({ title: s(x.title, 300), domain: s(hostName(x.url) || "unknown", 200), url: /^https?:\/\//i.test(String(x.url || "")) ? s(x.url, 800) : "",
    retrieved: x.retrieved_at ? s(new Date(x.retrieved_at).toISOString().slice(0, 10), 80) : undefined, kind: s(x.quality && x.quality.kind, 40), confirmed: x.confirmed ? true : undefined });
}
function claimPrim(c) {
  return clean({ text: s(c.value, 600), label: s(c.label, 40), confidence: s(c.confidence, 10), sources: (c.sources || []).slice(0, 6).map(sourcePrim), note: s(c.notes, 600) });
}
function planPrim(p) {
  return { type: "PLAN_OBJECT", data: { goal: s(p.goal, 200), steps: (p.steps || []).slice(0, 20).map((x) => ({ text: s(x.why, 300), requires: s(x.requires, 20), available: !!x.available })) } };
}

/* surface type -> {mode, surfaces} */
function fromSurface(sf, result) {
  if (!sf) return { mode: "answer", surfaces: [] };
  const items = (xs) => (xs || []).slice(0, 12).map(itemPrim);
  switch (sf.type) {
    case "attention":
      return { mode: "exceptions", surfaces: sf.items && sf.items.length ? items(sf.items) : [] };
    case "step_away":
      return { mode: "step_away", surfaces: [{ type: "CLEAR_STATE", data: { clear: !!sf.clear, checked: (sf.checked || []).map((x) => s(x, 120)), not_checked: (sf.not_checked || []).map((x) => s(x, 200)) } }].concat(items(sf.before)) };
    case "state":
      return { mode: "state", surfaces: [{ type: "TIMELINE", data: { basis: "The House", events: (sf.lines || []).map((l) => ({ text: s(l.k + ": " + l.v, 500) })) } }].concat(items(sf.top)) };
    case "briefing": {
      const out = [];
      for (const sec of sf.sections || []) {
        if (sec.lines) out.push({ type: "TIMELINE", data: { basis: s(sec.title, 120), events: sec.lines.map((l) => ({ text: s(l.k + ": " + l.v, 500) })) } });
        if (sec.items) out.push(...items(sec.items.slice(0, 3)));
        if (out.length >= 14) break;
      }
      return { mode: "state", surfaces: out.slice(0, 16) };
    }
    case "command_center":
      return { mode: "ambient", surfaces: [] };
    case "money": {
      const parts = (sf.items || []).slice(0, 8).map((i) => clean({ label: s(i.entity ? (i.entity.client_name || i.entity.name) : i.title, 120), amount: num(i.amount) || 0,
        sub: s(i.entity ? i.entity.name + " · " + (i.entity.stage || "") : i.detail, 200), entity: entity(i.entity), evidence: evidence(i.evidence) }));
      return { mode: "money", surfaces: [{ type: "MONEY_FLOW", data: clean({ headline: "OUTSTANDING", total: num(sf.receivable), parts, evidence: evidence(sf.items && sf.items[0] && sf.items[0].evidence) }) }] };
    }
    case "money_entity":
      return { mode: "money", focus: sf.entity, surfaces: [{ type: "MONEY_FLOW", data: clean({ headline: s((sf.entity.client_name || "Client") + " · " + (sf.entity.name || ""), 200), total: num(sf.outstanding),
        parts: sf.parts.map((p) => clean({ label: s(p.label, 120), amount: num(p.amount) || 0, sub: s(p.sub, 200) })), evidence: evidence(sf.evidence) }) }] };
    case "waiting": return { mode: "exceptions", surfaces: items(sf.items) };
    case "commitments": return { mode: "exceptions", surfaces: items(sf.items) };
    case "pipeline": return { mode: "exceptions", surfaces: items(sf.items) };
    case "production": {
      const by = {};
      (sf.healthy || []).forEach((p) => { by[p.stage] = by[p.stage] || { stage: p.stage, count: 0, attention: 0 }; by[p.stage].count++; });
      (sf.exceptions || []).forEach((i) => { const st = (i.entity && i.entity.stage) || "Other"; by[st] = by[st] || { stage: st, count: 0, attention: 0 }; by[st].attention++; });
      const order = ["Inquiry", "Design", "CAD", "Awaiting approval", "Deposit due", "Production", "Quality control", "Balance due", "Ready"];
      const stages = Object.values(by).sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));
      return { mode: "production", surfaces: [{ type: "PRODUCTION_FLOW", data: { stages, healthy: (sf.healthy || []).length } }].concat(items(sf.exceptions)) };
    }
    case "changes":
      return { mode: "timeline", surfaces: [{ type: "TIMELINE", data: clean({ basis: s(sf.basis, 120), events: (sf.changes || []).slice(0, 40).map((c) => clean({ text: s(c.text, 500), tone: s(c.tone, 12) })) }) }] };
    case "decisions":
      return { mode: "decision", surfaces: (sf.decisions || []).slice(0, 8).map(decisionPrim) };
    case "decision_pending":
      return { mode: "decision", surfaces: [decisionPrim(sf.decision)] };
    case "systems":
      return { mode: "systems", surfaces: [{ type: "SYSTEM_HEALTH", data: { systems: [{ name: "Calculator", on: !!(sf.calculator && sf.calculator.connected), detail: s(sf.calculator && (sf.calculator.connected ? sf.calculator.age : "not connected"), 200) },
        { name: "Grok", on: !!(sf.provider && sf.provider.status === "CONNECTED"), detail: s(sf.provider && (sf.provider.status === "CONNECTED" ? sf.provider.model : sf.provider.detail), 200) }]
        .concat((sf.domains || []).filter((d) => d.id !== "royal_t").map((d) => ({ name: s(d.name, 120), on: d.status === "CONNECTED", detail: d.status === "CONNECTED" ? "connected" : "not connected" }))) } }].concat(items(sf.items)) };
    case "project": {
      const p = sf.project, a = sf.answer;
      const facts = (a.verified || []).map((v) => clean({ k: "Verified", v: s(v.text, 500), label: s(v.label, 40), source: s(v.source, 80), age: s(v.age, 80) }));
      return { mode: "focus", focus: { id: p.id }, surfaces: [{ type: "ENTITY_CORE", data: clean({ entity: entity({ type: "project", id: p.id, name: p.name, client_name: p.client && p.client.name, stage: p.stage }),
        facts, unknown: (a.unknown || []).map((x) => s(x, 300)), owner: s(a.owner, 120), next_action: s(a.next_action, 500), deadline: s(a.deadline, 40), risk: s(a.risk, 8), why: s(a.why, 1500) }) }]
        .concat(items(sf.items).slice(0, 4)).concat((sf.decisions || []).filter((d) => d.status === "OPEN").slice(0, 2).map(decisionPrim)) };
    }
    case "clarify":
      return { mode: "clarify", surfaces: [{ type: "SEARCH_RESULTS", data: { prompt: "Which one?", candidates: (sf.candidates || []).slice(0, 12).map((c) => clean({ id: s(c.id, 80), name: s(c.name, 200), client_name: s(c.client_name, 200), stage: s(c.stage, 60) })) } }] };
    case "not_connected":
      return { mode: "not_connected", surfaces: [{ type: "NOT_CONNECTED", data: clean({ what: s(sf.domain === "royal_t" ? "The Project Calculator" : (sf.what || "That system"), 200), detail: s(sf.detail, 500),
        domains: sf.domains ? sf.domains.map((d) => clean({ name: s(d.name, 120), description: s(d.description, 300) })) : undefined }) }] };
    case "personal_home":
      return { mode: "not_connected", surfaces: [] };
    case "handled":
      return { mode: "decision", surfaces: [{ type: "ACTION_CONFIRMATION", data: { text: s(result.summary, 1000), done: (sf.done || []).length, pending: (sf.pending || []).length, refused: (sf.refused || []).length } }]
        .concat((sf.pending || []).slice(0, 6).filter((p) => p.result && p.result.decision).map((p) => decisionPrim(p.result.decision))) };
    case "message_draft":
      return { mode: "draft", focus: sf.entity, surfaces: [{ type: "MESSAGE_VIEW", data: clean({ to: s(sf.to, 200), purpose: s(sf.purpose, 200), body: s(sf.body, 4000), by: s(sf.by, 40), label: "RECOMMENDATION" }) }] };
    case "calc":
      return { mode: "answer", surfaces: [{ type: "STATEMENT", data: { text: s(sf.formatted, 200), tone: "calm", evidence: { label: "VERIFIED", source: "calculation", note: s(sf.expression, 300) } } }] };
    case "world":
      return { mode: "answer", surfaces: [{ type: "STATEMENT", data: clean({ text: s(result.summary, 2000), evidence: { label: s(sf.label, 40), note: s(sf.note, 300) } }) }] };
    case "knowledge":
      return { mode: "knowledge", surfaces: [{ type: "KNOWLEDGE_OBJECT", data: clean({ answer: s(sf.answer, 1500), label: s(sf.label || "VERIFIED_INTERNAL", 40),
        passages: (sf.passages || []).slice(0, 5).map((p) => clean({ citation: s(p.citation, 300), text: s(p.text, 1000), status: s(p.status, 20), binding: typeof p.binding === "boolean" ? p.binding : undefined, synthetic: p.synthetic || undefined })),
        unknowns: (sf.unknowns || []).slice(0, 4).map((u) => s(u, 300)) }) }] };
    case "research": {
      const r = sf.report;
      return { mode: "research", surfaces: [{ type: "RESEARCH_OBJECT", data: clean({ question: s(r.question, 1000), answer: s(r.answer, 2000), confidence: s(r.confidence, 10),
        claims: (r.claims || []).slice(0, 10).map(claimPrim), conflicts: (r.conflicts || []).slice(0, 5).map((c) => s(c.summary, 800)), unknowns: (r.unknowns || []).slice(0, 8).map((u) => s(u, 300)),
        sources: (r.sources || []).slice(0, 12).map(sourcePrim), retrieved: r.retrieved_at ? s(new Date(r.retrieved_at).toISOString().slice(0, 16).replace("T", " ") + " UTC", 80) : undefined,
        note: r.stale ? "From expired research." : r.from_cache ? "From earlier research." : undefined }) }] };
    }
    case "person":
    case "contact": {
      const p = sf.person || {}, co = sf.company || { name: p.company };
      const c = sf.contact;
      return { mode: "person", surfaces: [{ type: "PERSON_OBJECT", data: clean({ name: s(p.name, 160), title: s(p.title, 200), role: s(sf.role && sf.role.name, 80), company: s(co.name || p.company || "", 200),
        domain: s(co.domain || p.domain, 200), since: s(p.since, 40), label: s(p.label || (p.name ? "REPORTED_UNVERIFIED" : "UNKNOWN"), 40), confidence: s(p.identity_confidence, 10),
        confirmed_on: s(p.confirmed_on && hostName(p.confirmed_on), 200), email: s(c ? c.email : p.email, 200), email_status: s(c ? c.status : p.email_status, 40),
        email_note: s(c ? [c.verification && c.verification.note].concat(c.notes || []).filter(Boolean).join(" ") : undefined, 500),
        others: (sf.candidates || []).slice(0, 6).map((x) => clean({ name: s(x.name, 160), title: s(x.title, 200), note: s(x.match_note, 200) })),
        conflict: s(sf.conflict && sf.conflict.summary, 800), sources: (p.sources || []).slice(0, 8).map(sourcePrim) }) }] };
    }
    case "company_choice":
      return { mode: "clarify", surfaces: [{ type: "STATEMENT", data: { text: s("Which one: " + (sf.candidates || []).map((c) => c.name + (c.domain ? " (" + c.domain + ")" : "")).join("; ") + "?", 2000), tone: "attention" } }] };
    case "email_draft": {
      const d = sf.draft;
      return { mode: "draft", surfaces: [{ type: "MESSAGE_VIEW", data: clean({ to: s(d.to_name, 200), purpose: s(d.objective, 200), body: s(d.body, 4000), by: s(String(d.agent || "ace").toUpperCase(), 40),
        label: "RECOMMENDATION", subject: s(d.subject, 200), address: s(d.to, 200), address_status: s(d.to_status, 40), method: s(d.method, 20) }) }] };
    }
    case "sources":
      return { mode: "research", surfaces: [{ type: "SOURCE_LIST", data: { sources: (sf.sources || []).slice(0, 20).map(sourcePrim), claims: (sf.claims || []).slice(0, 8).map(claimPrim) } }] };
    case "prospects":
      return { mode: "research", surfaces: [{ type: "PROSPECT_LIST", data: { note: "Nothing here is in a CRM. People are reported by sources unless marked verified.",
        items: (sf.items || []).slice(0, 10).map((i) => clean({ company: s(i.company, 160), domain: s(i.domain, 160), why: s(i.why, 400), person: s(i.person, 160), title: s(i.title, 200), label: s(i.label, 40),
          sources: (i.sources || []).slice(0, 4).map(sourcePrim) })) } }].concat(sf.plan ? [planPrim(sf.plan)] : []) };
    case "plan":
      return { mode: "plan", surfaces: sf.plan ? [planPrim(sf.plan)] : [] };
    case "task":
      return { mode: "answer", surfaces: [{ type: "TASK_OBJECT", data: clean({ agent: s(String(sf.task.agent).toUpperCase(), 40), objective: s(sf.task.objective, 500), status: s(sf.task.status, 30),
        created: s(new Date(sf.task.created_at).toISOString().slice(0, 16).replace("T", " ") + " UTC", 80) }) }] };
    case "realm_switch":
      return { mode: "answer", surfaces: [] };
    case "cleared":
      return { mode: "ambient", surfaces: [] };
    case "back":
      return { mode: "back", surfaces: [] };
    case "text":
    case "suggest":
    default:
      return { mode: "answer", surfaces: sf.label ? [{ type: "STATEMENT", data: clean({ text: s(result.summary, 2000), evidence: { label: s(sf.label, 40), note: sf.based_on && sf.based_on.length ? "Based on " + sf.based_on.length + " verified fact" + (sf.based_on.length === 1 ? "" : "s") : undefined } }) }] : [] };
  }
}

/* What ROYAL says aloud is shorter than what it shows.  A long answer is
   spoken as its first sentence or two (up to about 240 characters), with a
   pointer to the screen when there is more to see there. */
export function spokenFrom(text, { onScreen = false } = {}) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= 240) return t;
  const sentences = t.match(/[^.!?]+[.!?]+(\s|$)/g) || [t];
  let out = "";
  for (const s of sentences) { if ((out + s).length > 240 && out) break; out += s; }
  out = out.trim() || t.slice(0, 240).replace(/\s+\S*$/, "") + ".";
  return out + (onScreen ? " The rest is on your screen." : "");
}

export function compose(result, { realm = "BUSINESS" } = {}) {
  const { mode, surfaces, focus } = fromSurface(result.surface, result);
  const agents = (result.delegations || []).map((d) => ({ id: d.agent, name: String(d.agent).toUpperCase(),
    state: d.status === "NOT_CONNECTED" ? "not_connected" : d.verified ? "reported" : "did_not_report" }))
    .filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i);   /* one node per specialist */
  const tone = ["RED", "BLACK"].indexOf(result.risk) >= 0 && result.requires_tahir ? "alert" : result.requires_tahir || result.requires_approval ? "attention" : "calm";
  const failed = result.status === "FAILED";
  const spec = {
    version: SPEC_VERSION, realm, tone: failed ? "attention" : tone,
    mode: failed ? "error" : mode,
    speech: spokenFrom(result.summary, { onScreen: true }).slice(0, 1200),
    focus_entity: focus && focus.id ? { type: "project", id: String(focus.id) } : (result.entity ? { type: "project", id: result.entity.id } : null),
    agents,
    surfaces: failed ? [{ type: "ERROR_OBJECT", data: { attempted: s(result.skill || "your request", 300), failed_because: s(result.summary, 500), impact: "No conclusion was drawn and nothing was changed." } }] : surfaces,
  };
  return validateSpec(spec);
}
