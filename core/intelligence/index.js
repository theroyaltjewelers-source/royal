/* ROYAL's intelligence layer: the part of ROYAL that decides

     Do I already know this?  Does the House know this?  Do I need live
     business data?  Do I need to search the world?  How deeply?  Do I need
     a specialist?  A tool?  A plan?  Do I have permission?  Do I need Tahir?
     Did the action actually succeed?

   and then does it.  House state still goes through ROYAL's deterministic
   skills (skills/index.js); this layer handles everything those skills do
   not: world knowledge, current research, executive and contact research,
   House knowledge, calculation, outreach drafting and revision, sending
   external email through approval, sources, cancellation, prospecting and
   delegation to external Grok Bots.

   Every handler returns the same shape as a skill:
     { status, summary, findings, surface, context, delegations }
   `context` is a patch to the conversation's active context. */

import { providerLine } from "../../web/js/notices.js";
import { EVIDENCE as E, RUN_STATUS, CONFIDENCE as C, EMAIL_STATUS as ES, PRIORITY as P, RISK as R } from "../enums.js";
import { stableHash, newId } from "../util.js";
import { systemPrompt } from "../identity.js";
import { HOUSE_NAMESPACES } from "./knowledge.js";
import { S } from "./jsonschema.js";
import { calculate } from "./calc.js";
import { classify, classifyByRules } from "./intent_engine.js";
import { reasoningPolicy } from "./reasoning.js";
import { planFor } from "./planner.js";
import { routeAgents, AgentTasks, GrokBotAdapter } from "./agents.js";
import { ResearchEngine, UNTRUSTED } from "./research/engine.js";
import { ExecutiveResearch, nameWithRole } from "./research/people.js";
import { ContactResearch, isBusinessEmail, splitName } from "./research/contacts.js";
import { emailHash } from "./comms.js";
import { hostOf, sourceQuality, sameSite } from "./truth.js";

const DRAFT_SCHEMA = S.obj({ subject: S.str(160), body: S.str(3000), notes: S.arr(S.str(200), 4) });
const KNOWLEDGE_SCHEMA = S.obj({ answer: S.str(1200), used: S.arr(S.str(40), 6), unknowns: S.arr(S.str(300), 4) });
const PROSPECT_SCHEMA = S.obj({
  companies: S.arr(S.obj({ name: S.str(160), domain: S.nstr(160), why_fit: S.str(400), buyer_name: S.nstr(160), buyer_title: S.nstr(200), source_urls: S.arr(S.str(600), 6) }), 10),
  unknowns: S.arr(S.str(300), 6),
});
const HOUSE_VOICE = "House style: short sentences, warm, confident, specific. No em dashes. No flattery. Never invent facts, prices, dates or promises. Sign as Tahir, The House of Royal T.";
const OPEN_DRAFT = (c) => c && c.active_draft && !c.active_draft.sent && !c.active_draft.cancelled;

export function createIntelligence({ provider, store, audit, gate, registry, decisions, flags = {}, clock = () => Date.now(), knowledge = null, fetcher = null,
  hunter = null, apollo = null, email = null, bridge = null, metrics = null } = {}) {
  const research = new ResearchEngine({ provider, fetcher, store, clock, flags, metrics, audit });
  const exec = new ExecutiveResearch({ research, fetcher, store, clock });
  const contacts = new ContactResearch({ hunter, apollo, fetcher, research, store, flags, clock, audit });
  const tasks = new AgentTasks({ store, clock, bridge, audit });
  const bots = bridge ? new GrokBotAdapter({ bridge, tasks }) : null;
  const modelOn = () => provider && provider.status().status !== "NOT_CONNECTED";
  const caps = () => (provider && provider.capabilities ? provider.capabilities() : {});
  const say = (status, summary, surface, extra = {}) => ({ status, summary, findings: [], surface, ...extra });

  function status() {
    const r = research.status(), c = contacts.status();
    return {
      provider: provider ? { id: provider.id, ...provider.status(), capabilities: caps() } : { status: "NOT_CONNECTED" },
      research: r, contacts: c, knowledge: knowledge ? { status: "CONNECTED", ...knowledge.stats() } : { status: "NOT_CONNECTED" },
      email: email ? email.status() : { status: "NOT_CONFIGURED", detail: "RESEND_API_KEY and ROYAL_EMAIL_FROM are not set." },
      sending: flags.agent_external_send ? "ENABLED" : "DISABLED", realtime_voice: flags.realtime_voice && caps().realtime_voice ? "AVAILABLE" : flags.realtime_voice ? "NOT_CONFIGURED" : "DISABLED",
      spoken_voice: flags.spoken_voice && caps().speech ? "AVAILABLE" : flags.spoken_voice ? "NOT_CONFIGURED" : "DISABLED",
      grok_bots: !bridge ? "NOT_CONNECTED" : bridge.enabled && !bridge.enabled() ? "DISABLED" : "CONNECTED", agent_orchestration: flags.advanced_agent_orchestration ? "ENABLED" : "DISABLED",
    };
  }

  /* --------------------------------------------------------- handlers --- */

  async function doCalculation(text) {
    const r = calculate(text);
    if (!r.ok) return say(RUN_STATUS.OK, r.failed_because === "CANNOT_EVALUATE" ? "I can't calculate that: " + String(r.detail || "").toLowerCase().replace(/_/g, " ") + "." : "I didn't find a calculation in that.", { type: "text" });
    return say(RUN_STATUS.OK, r.formatted + ".", { type: "calc", expression: r.expression, value: r.value, formatted: r.formatted });
  }

  async function doKnowledge(text, policy) {
    if (!knowledge) return say(RUN_STATUS.NOT_CONNECTED, "The House documents are not loaded, so I can't answer from House policy.", { type: "text" });
    /* House policy questions read House documents only; the general
       reference never stands in for what the House has decided. */
    const hits = knowledge.search(text, { limit: 5, namespaces: HOUSE_NAMESPACES });
    if (!hits.length) return say(RUN_STATUS.OK, "The House documents don't cover that yet. It isn't written policy, so I won't guess.", { type: "knowledge", answer: null, passages: [] },
      { context: { focus: "house" } });
    const top = hits[0];
    const statusNote = (h) => (h.policy_id ? (h.binding ? h.policy_id + " is ACTIVE policy." : h.policy_id + " is " + (h.policy_status || "not active") + ", so it is not decided policy yet.") : "");
    let answer = null, used = hits.slice(0, 2), unknowns = [];
    if (modelOn() && caps().structured_output) {
      const r = await provider.structured({ name: "house_answer", schema: KNOWLEDGE_SCHEMA, level: 1, timeout_ms: 20000,
        system: systemPrompt("TASK: Answer Tahir's question only from the House passages in <data>. Quote numbers exactly. If a passage's status is not ACTIVE, say it is not decided policy.",
          "If the passages do not answer it, say so and list what is unknown. " + UNTRUSTED),
        messages: [{ role: "user", content: "<data>" + JSON.stringify(hits.map((h) => ({ id: h.id, source: h.citation, status: h.policy_status || h.doc_status, text: h.text.slice(0, 1500) }))) + "</data>\nQuestion: " + text }] });
      if (r.ok) { answer = r.value.answer; used = hits.filter((h) => r.value.used.indexOf(h.id) >= 0); unknowns = r.value.unknowns; if (!used.length) used = hits.slice(0, 1); }
    }
    const title = top.policy_id ? ((/^\*\*POL-[A-Z]+-\d+\s+([^*]+?)\.?\*\*/.exec(top.text) || [])[1] || "") : "";
    const firstClause = top.text.replace(/^\*\*[^*]+\*\*\s*(Status:\s*[A-Z_]+\.)?\s*/, "").replace(/\s+/g, " ").split(/\s\([b-z]\)\s/)[0].replace(/^\(a\)\s*/, "").slice(0, 260);
    const summary = answer ? answer
      : top.policy_id ? (top.binding ? top.policy_id + " (" + title + ") says: " + firstClause : top.policy_id + " (" + title + ") covers this, but it isn't decided policy yet: it's marked " + (top.policy_status || "not active") + ". The passage is below.")
      : "The " + String(top.title || top.path).replace(/^THE HOUSE OF ROYAL T:\s*/i, "") + " covers this (" + top.section + "). The passage is below.";
    return say(RUN_STATUS.OK, summary.slice(0, 1200), { type: "knowledge", answer: answer || null, label: answer ? E.INFERENCE : E.VERIFIED_INTERNAL, unknowns,
      passages: used.map((h) => ({ citation: h.citation, text: h.text.slice(0, 900), status: h.policy_status || h.doc_status || null, binding: h.binding, synthetic: h.synthetic })) },
      { context: { focus: "house" } });
  }

  /* Current law, tax and regulation: never answered from a static
     reference or from memory; always researched from current sources. */
  const TIME_SENSITIVE_RULE = /\b(tax(es)?|irs|sales tax|use tax|1099|w-?2|w-?9|payroll tax|estimated (tax|payments?)|deduct(ible|ion)|depreciation (rule|limit|schedule)s?|filing (deadline|date|requirement)s?|(law|laws|legal|regulation|regulations|compliance|licen[cs]e) (require|requirement|apply|say|rule)|is it legal|minimum wage|section 179|bonus depreciation)\b/i;

  /* A business concept ("what is working capital?") is answered from the
     executive knowledge fabric (docs/knowledge/), labelled as general
     reference, not House policy.  With a model, one grounded call; without
     one, the passage itself. */
  async function fromFabric(text, policy) {
    if (!knowledge) return null;
    const hits = knowledge.search(text, { limit: 3, namespaces: ["fabric"] });
    if (!hits.length || hits[0].score < 2) return null;
    const label = "From my business reference (general knowledge, not House policy)";
    const passages = hits.slice(0, 2).map((h) => ({ citation: h.citation, text: h.text.slice(0, 900), status: null, binding: null, reference: true }));
    if (modelOn() && policy.use_model) {
      const r = await provider.complete({ level: 1, max_tokens: 400,
        system: systemPrompt("TASK: Answer Tahir's business question from the reference passages in <data>, briefly and in plain words; relate it to the House if that helps. If the passages do not answer it, say so. The reference is general knowledge, not House policy.", UNTRUSTED),
        messages: [{ role: "user", content: "<data>" + JSON.stringify(passages) + "</data>\nQuestion: " + text }] });
      if (r.ok) return say(RUN_STATUS.OK, r.text.slice(0, 1500), { type: "knowledge", answer: r.text, label: E.INFERENCE, note: label, unknowns: [], passages });
    }
    const first = hits[0].text.split("\n").filter((l) => l.trim() && !/^#/.test(l)).join(" ").replace(/\s+/g, " ").slice(0, 500);
    return say(RUN_STATUS.OK, first, { type: "knowledge", answer: null, label: E.VERIFIED_INTERNAL, note: label, unknowns: [], passages });
  }

  async function doWorld(text, intent, policy) {
    const rs = research.status();
    if (TIME_SENSITIVE_RULE.test(text)) {
      if (rs.status !== "CONNECTED") return say(RUN_STATUS.NOT_CONNECTED, "That's a current tax or legal rule, which changes, so I only answer it from current official sources, and web research isn't available (" + rs.detail + "). I can explain the concept, and the House's accountant or lawyer should confirm the rule.", { type: "text" });
      return doResearch(text + " (use current official government sources; name the jurisdiction)", { ...intent, intent: "current_research", needs_current_web: true }, { ...policy, allow_search: true, research_depth: "STANDARD" });
    }
    const wantsCurrent = intent.needs_current_web || intent.intent === "current_research";
    if (!wantsCurrent) { const f = await fromFabric(text, policy); if (f) return f; }
    /* The reasoning policy decides: search only where it allows search, the
       model only where it allows the model, at the model tier it names. */
    if (wantsCurrent && policy.allow_search) {
      if (rs.status !== "CONNECTED") return say(RUN_STATUS.NOT_CONNECTED, "That needs current information, and web research isn't available (" + rs.detail + "). I won't answer it from memory as if it were current.", { type: "text" });
      return doResearch(text, intent, policy);
    }
    if (modelOn() && policy.use_model) {
      const r = await provider.complete({ level: policy.model_tier === "fast" ? 1 : policy.level, max_tokens: policy.max_tokens,
        system: systemPrompt("TASK: Answer briefly and accurately from general knowledge. If you are not sure, say so. If the answer may have changed recently, say it may be out of date.", UNTRUSTED),
        messages: [{ role: "user", content: text }] });
      if (r.ok) return say(RUN_STATUS.OK, r.text.slice(0, 1500), { type: "world", label: E.MODEL_KNOWLEDGE, note: "From the language model's general knowledge, not checked against a source." });
      if (rs.status === "CONNECTED" && policy.allow_search) return doResearch(text, intent, policy);
      return say(RUN_STATUS.FAILED, providerLine(r) + " Nothing was made up in its place.", { type: "text" });
    }
    /* No model: a world question may still be answered from cited research
       rather than not at all.  This is a deliberate fallback, not the
       policy's first choice, and the answer carries its sources. */
    if (rs.status === "CONNECTED") return doResearch(text, intent, { ...policy, research_depth: policy.research_depth || "QUICK" });
    return say(RUN_STATUS.NOT_CONNECTED, "Questions about the world need the language provider, which isn't connected. I answer House questions from the records.", { type: "text" });
  }

  async function doResearch(text, intent, policy) {
    const r = await research.research(text, { depth: policy.research_depth || intent.research_depth || "QUICK" });
    if (!r.ok) return say(r.status === "FAILED" ? RUN_STATUS.FAILED : RUN_STATUS.NOT_CONNECTED, researchDown(r), { type: "text" });
    const lead = r.conflicts.length ? "Sources disagree. " + r.conflicts[0].summary : r.answer;
    return say(RUN_STATUS.OK, (lead + confidenceLine(r.confidence, r.from_cache, r.stale)).slice(0, 1500), { type: "research", report: r },
      { context: { focus: "research", last_research: brief(r) } });
  }

  async function doPeople(text, intent, convo) {
    const company = intent.entities.company || (intent.refers_to_context && convo.active_company ? convo.active_company.name : null);
    const role = intent.entities.role || "CFO";
    if (!company) return say(RUN_STATUS.NEEDS_CLARIFICATION, "Which company?", { type: "text" });
    if (flags.people_research === false) return say(RUN_STATUS.NOT_CONNECTED, "People research is switched off.", { type: "text" });
    const known = convo.active_company && convo.active_company.name.toLowerCase() === company.toLowerCase() ? convo.active_company : null;
    const r = await exec.roleHolder(company, role, { company: known || null });
    if (!r.ok) return say(r.status === "FAILED" ? RUN_STATUS.FAILED : RUN_STATUS.NOT_CONNECTED, researchDown(r), { type: "text" });
    if (r.status === "AMBIGUOUS") return say(RUN_STATUS.NEEDS_CLARIFICATION, "More than one company goes by " + company + ". Which one?",
      { type: "company_choice", candidates: r.candidates.map((c) => ({ name: c.name, domain: c.official_domain, description: c.description })) });
    if (r.status === "NOT_FOUND" && !r.company) return say(RUN_STATUS.OK, "I couldn't identify a company called " + company + " from current sources.", { type: "text" });
    const co = r.company;
    const ctx = { focus: "research", active_company: { company_id: co.company_id, name: co.name, domain: co.domain }, last_research: { question: text, sources: r.sources, claims: r.claims, retrieved_at: r.retrieved_at } };
    if (r.status === "CONFLICT") return say(RUN_STATUS.OK, r.conflict.summary + " I won't pick one. Say which source to trust, or I can dig deeper.", { type: "person", company: co, person: null, candidates: r.candidates, conflict: r.conflict, role: r.role }, { context: ctx });
    if (r.status === "ONLY_RELATED_ROLES") {
      const c = r.candidates[0];
      return say(RUN_STATUS.OK, "I found no current " + r.role.abbr + " for " + co.name + ". The closest: " + c.name + ", " + c.title + " (" + c.match_note + ").", { type: "person", company: co, person: null, candidates: r.candidates, role: r.role }, { context: ctx });
    }
    if (r.status === "NOT_FOUND") return say(RUN_STATUS.OK, "I couldn't find who is " + r.role.abbr + " of " + co.name + " in current sources.", { type: "person", company: co, person: null, candidates: [], role: r.role, unknowns: r.unknowns }, { context: ctx });
    const p = r.person;
    const how = p.label === E.VERIFIED_EXTERNAL ? "confirmed on " + hostOf(p.confirmed_on) : p.cross_checked ? "found on " + hostOf(p.confirmed_on) + ", not a primary source" : "reported by " + [...new Set(p.sources.map((s) => hostOf(s.url)))].slice(0, 2).join(" and ") + ", not confirmed by me";
    ctx.active_person = { person_id: p.person_id, name: p.name, title: p.title, company: co.name, company_id: co.company_id, domain: co.domain };
    return say(RUN_STATUS.OK, p.name + ", " + p.title + (p.since ? " since " + p.since : "") + ". " + cap(how) + "." + confidenceLine(p.identity_confidence),
      { type: "person", company: co, person: p, candidates: r.candidates.filter((c) => c.name !== p.name), role: r.role }, { context: ctx });
  }

  async function doContact(text, intent, convo) {
    const person = convo.active_person;
    if (!person) return say(RUN_STATUS.NEEDS_CLARIFICATION, "Whose email? Tell me the person and company, or ask me to find them first.", { type: "text" });
    const r = await contacts.businessEmail(person);
    const words = {
      [ES.PUBLICLY_LISTED]: "published on " + (r.source ? hostOf(r.source) : "the company's site") + " and confirmed on the page",
      [ES.PROVIDER_FOUND]: "found by " + r.found_by + ", not independently verified",
      [ES.PATTERN_INFERRED]: "a guess from the company's email pattern, not verified",
      [ES.VERIFIED_DELIVERABLE]: "verified deliverable by " + (r.verification && r.verification.provider),
      [ES.LIKELY_DELIVERABLE]: "the pattern guess checked out as deliverable, but it came from a pattern",
      [ES.INVALID]: "the verifier says it is invalid; don't use it",
      [ES.RISKY]: "risky: it may not reach anyone",
      [ES.UNVERIFIED]: "found " + (r.found_by || "on a public page") + ", not verified",
    };
    let summary;
    if (r.status === ES.NOT_FOUND) {
      const st = contacts.status();
      summary = r.opted_out ? person.name + " asked not to be listed by the contact provider, so I won't look up or guess an address." : "I don't have a business email for " + person.name + "." + (st.discovery !== "CONNECTED" ? " Contact providers aren't " + (st.discovery === "DISABLED" ? "switched on" : "configured") + ", and nothing was published that I could confirm." : "") + " I won't guess one.";
    } else {
      summary = person.name.split(" ")[0] + "'s email: " + r.email + ", " + (words[r.status] || r.status.toLowerCase()) + "." + (r.verification && r.verification.note && r.status !== ES.VERIFIED_DELIVERABLE ? " " + r.verification.note : "");
    }
    const updated = { ...person, email: r.email || null, email_status: r.status };
    return say(RUN_STATUS.OK, summary, { type: "contact", person: updated, contact: r }, { context: { focus: "research", active_person: updated } });
  }

  /* ACE drafts an outreach from a structured handoff. */
  async function draftOutreach(handoff) {
    if (modelOn() && caps().structured_output) {
      const r = await provider.structured({ name: "outreach_draft", schema: DRAFT_SCHEMA, level: 2, timeout_ms: 30000,
        system: ["You are ACE, the sales intelligence of The House of Royal T, a private, appointment-only custom luxury jewelry house.",
          "Write a first outreach email from Tahir to the person in <data>, for the objective in <data>. Under 140 words unless asked otherwise.",
          "Use only facts in <data>. Do not claim a relationship that does not exist. No pricing, no dates, no discounts. " + HOUSE_VOICE, UNTRUSTED].join("\n"),
        messages: [{ role: "user", content: "<data>" + JSON.stringify(handoff) + "</data>" }] });
      if (r.ok) return { ok: true, subject: r.value.subject, body: r.value.body, method: "model", notes: r.value.notes };
      return { ok: false, failed_because: r.failed_because };
    }
    const first = handoff.person ? splitName(handoff.person.name).first : "there";
    const body = ["Hi " + first + ",", "",
      "I'm Tahir, founder of The House of Royal T, a private custom jewelry house. I'd like to explore " + handoff.objective + " with " + handoff.company.name + ".",
      "", "Would you be open to a short call in the next couple of weeks?", "", "Best,", "Tahir", "The House of Royal T"].join("\n");
    return { ok: true, subject: cap(handoff.objective) + " | The House of Royal T", body, method: "template", notes: ["Written from a template: the language provider isn't connected."] };
  }

  async function doOutreach(text, intent, convo, run_id) {
    const person = convo.active_person, company = convo.active_company;
    if (!person && !company) return say(RUN_STATUS.NEEDS_CLARIFICATION, "Who is it for? Tell me the person or company first.", { type: "text" });
    /* Which specialist writes it comes from the Agent Registry's capabilities
       (or Tahir naming one), not from a fixed choice. */
    const route = routeAgents({ ...intent, intent: "outreach_draft" }, text, { registry, flags })[0];
    const agentId = route ? route.agent : "ace";
    const agent = registry.get(agentId);
    if (!agent || agent.status !== "ACTIVE") return say(RUN_STATUS.NOT_CONNECTED, (agent ? agent.name : agentId.toUpperCase()) + " isn't connected, so it can't write this. ACE can.", { type: "text" });
    const objective = objectiveFrom(text, convo.conversation_goal);
    const offer = knowledge ? knowledge.search(objective + " offer service", { limit: 3, includeTraining: false, namespaces: HOUSE_NAMESPACES }) : [];
    const handoff = {
      person: person ? { person_id: person.person_id, name: person.name, title: person.title, email: person.email || null, email_status: person.email_status || null } : null,
      company: company ? { company_id: company.company_id, name: company.name, domain: company.domain } : { name: person.company },
      objective, requested_output: "a short, personalised first outreach email",
      research_summary: convo.last_research ? (convo.last_research.claims || []).slice(0, 4).map((c) => c.value + " (" + c.label + ")") : [],
      source_references: convo.last_research ? (convo.last_research.sources || []).slice(0, 4).map((s) => s.url) : [],
      house_context: offer.map((h) => ({ source: h.citation, text: h.text.slice(0, 600), binding: h.binding })),
      constraints: ["no pricing", "no promised dates", "no invented facts", "under 140 words"],
    };
    const g = await gate.request({ agentId, tool: "draft_email", args: { handoff }, domain: "world", run_id });
    if (g.status !== "OK") return say(RUN_STATUS.OK, agent.name + " can't write that (" + (g.reason || g.failed_because || g.status) + ").", { type: "text" });
    const d = g.output;
    if (!d || !d.ok) return say(RUN_STATUS.FAILED, agent.name + " couldn't finish the draft (" + ((d && d.failed_because) || "unknown") + "). Nothing was written.", { type: "text" },
      { delegations: [{ agent: agentId, status: RUN_STATUS.FAILED, verified: false, errors: [(d && d.failed_because) || "unknown"] }] });
    /* A new draft replaces the one under discussion; an approval asked for the
       old one no longer describes what would be sent. */
    if (OPEN_DRAFT(convo) && convo.active_draft.decision_id) await decisions.cancel(convo.active_draft.decision_id, "replaced by a new draft");
    const addr = person && person.email && isBusinessEmail(person.email, person.domain) && [ES.INVALID, ES.NOT_FOUND].indexOf(person.email_status) < 0 ? person.email : null;
    const draft = { id: newId("drf"), kind: "email", agent: agentId, to: addr, to_name: person ? person.name : company.name, to_status: person && person.email_status || null,
      person_id: person ? person.person_id || null : null,
      company: handoff.company.name, subject: d.subject, body: d.body, method: d.method, objective, created_at: clock(), version: 1, sent: false, handoff_id: stableHash(handoff) };
    const summary = agent.name + " drafted it" + (d.method === "template" ? " from a template, since the language provider isn't connected" : "") + ". Nothing has been sent." +
      (addr ? "" : " I don't have a usable address for " + draft.to_name + " yet.") + " Say \"send it\" when you're ready.";
    return say(RUN_STATUS.OK, summary, { type: "email_draft", draft },
      { context: { focus: "research", active_draft: draft, conversation_goal: objective }, delegations: [{ agent: agentId, status: RUN_STATUS.OK, verified: true, errors: [] }] });
  }

  async function doRevise(text, convo) {
    const cur = convo.active_draft;
    if (!OPEN_DRAFT(convo)) return say(RUN_STATUS.NEEDS_CLARIFICATION, "There's no draft open to change.", { type: "text" });
    let subject = cur.subject, body = cur.body, method;
    if (modelOn() && caps().structured_output) {
      const r = await provider.structured({ name: "revised_draft", schema: DRAFT_SCHEMA, level: 1, timeout_ms: 25000,
        system: ["Revise the email in <data> as Tahir asks. Keep every fact; add none. Keep the recipient and the purpose. " + HOUSE_VOICE, UNTRUSTED].join("\n"),
        messages: [{ role: "user", content: "<data>" + JSON.stringify({ subject: cur.subject, body: cur.body }) + "</data>\nRevision: " + text.slice(0, 300) }] });
      if (!r.ok) return say(RUN_STATUS.FAILED, "The rewrite didn't come back in a usable form (" + r.failed_because + "). The draft is unchanged.", { type: "email_draft", draft: cur });
      subject = r.value.subject; body = r.value.body; method = "model";
    } else if (/\b(short|shorten|tighten|trim|brief)/i.test(text)) {
      body = shorten(cur.body); method = "rule";
    } else return say(RUN_STATUS.NOT_CONNECTED, "Changing the tone needs the language provider, which isn't connected. I can make it shorter.", { type: "email_draft", draft: cur });
    const draft = { ...cur, id: newId("drf"), subject, body, method, version: (cur.version || 1) + 1, created_at: clock(), previous: cur.id };
    /* An open approval for the old wording no longer describes what would be sent. */
    if (cur.decision_id) await decisions.cancel(cur.decision_id, "the draft was revised");
    delete draft.decision_id;
    return say(RUN_STATUS.OK, "Revised" + (method === "rule" ? " (shortened by rule, without the language model)" : "") + ". Nothing has been sent.", { type: "email_draft", draft },
      { context: { active_draft: draft }, delegations: [{ agent: cur.agent || "ace", status: RUN_STATUS.OK, verified: true, errors: [] }] });
  }

  async function doSend(convo, run_id, text = "") {
    const d = convo.active_draft;
    if (!OPEN_DRAFT(convo)) return say(RUN_STATUS.NEEDS_CLARIFICATION, "Send what? There's no draft open in this conversation.", { type: "text" });
    /* Consequential ambiguity stops here: never guess which message to send. */
    if (convo.pending_draft && !/\b(email|intro|introduction|outreach|pitch)\b/i.test(text))
      return say(RUN_STATUS.NEEDS_CLARIFICATION, "Two messages are open: the email to " + d.to_name + " and the " + (convo.pending_draft.purpose || "update") + " for " + (convo.pending_draft.client_name || "a client") +
        ". Say \"send the email\" or \"send the update\".", { type: "text" });
    const ap = convo.active_person;
    if (ap && d.person_id && ap.person_id && ap.person_id !== d.person_id && !new RegExp("\\b" + escapeRe(String(d.to_name || "").split(" ")[0]) + "\\b", "i").test(text))
      return say(RUN_STATUS.NEEDS_CLARIFICATION, "The open draft is to " + d.to_name + ", but we've since been talking about " + ap.name + ". Should the draft go to " + d.to_name + "? Say \"send it to " + String(d.to_name).split(" ")[0] + "\" to confirm.", { type: "email_draft", draft: d });
    /* Already decided: never ask twice, never send twice. */
    if (d.decision_id) {
      const prev = await decisions.get(d.decision_id);
      if (prev && ["APPROVED", "MODIFIED", "EXECUTED", "VERIFIED"].indexOf(prev.status) >= 0)
        return say(RUN_STATUS.OK, "That email was already " + (prev.status === "VERIFIED" || prev.status === "EXECUTED" ? "sent" : "approved") + ". I won't send it twice.", { type: "decision_pending", decision: prev });
    }
    if (!d.to) return say(RUN_STATUS.NEEDS_CLARIFICATION, "I don't have an address for " + d.to_name + ". Ask me to find their business email, or tell me the address.", { type: "email_draft", draft: d });
    const args_hash = emailHash({ to: d.to, subject: d.subject, body: d.body });
    const unverified = [ES.VERIFIED_DELIVERABLE, ES.PUBLICLY_LISTED].indexOf(d.to_status) < 0;
    const g = await gate.request({ agentId: "royal", tool: "send_email", domain: "world", run_id,
      args: { draft: { to: d.to, subject: d.subject, body: d.body }, args_hash, draft_id: d.id },
      decision: { title: "Send email to " + d.to_name + " (" + d.to + ")", description: "Subject: " + d.subject + "\n\n" + d.body, priority: P.P2, risk: unverified ? R.ORANGE : R.YELLOW,
        recommended_option: "APPROVE", reasoning_summary: "Drafted by " + String(d.agent || "ace").toUpperCase() + " for: " + d.objective + ".",
        facts: ["Recipient: " + d.to_name + ", " + d.company, "Address status: " + String(d.to_status || "unknown").toLowerCase().replace(/_/g, " ")],
        unknowns: unverified ? ["The address is not verified deliverable."] : [], expected_result: "One email, exactly as shown, to " + d.to + ".",
        source: "research", dedupe_key: "email:" + args_hash } });
    if (g.status !== "PENDING_APPROVAL") return say(RUN_STATUS.OK, "I can't send that (" + (g.reason || g.status) + "). Nothing was sent.", { type: "text" });
    if (g.already_decided) return say(RUN_STATUS.OK, "That exact email was already " + (["VERIFIED", "EXECUTED"].indexOf(g.decision.status) >= 0 ? "sent" : "approved") + ". I won't send it twice.",
      { type: "decision_pending", decision: g.decision }, { context: { active_draft: { ...d, decision_id: g.decision.id, sent: ["VERIFIED", "EXECUTED"].indexOf(g.decision.status) >= 0 } } });
    const canSend = flags.agent_external_send && email && email.configured();
    return say(RUN_STATUS.OK, "It goes to " + d.to_name + " at " + d.to + ", exactly as written, once you approve it." +
      (unverified ? " The address isn't verified." : "") + (canSend ? "" : " Email sending isn't connected yet, so approving records the decision and nothing is sent."),
      { type: "decision_pending", decision: g.decision }, { context: { active_draft: { ...d, decision_id: g.decision.id } } });
  }

  async function doSources(convo) {
    const lr = convo.last_research;
    if (!lr || !(lr.sources || []).length) return say(RUN_STATUS.OK, "I haven't used outside sources in this conversation. House answers come from the calculator and the House documents.", { type: "text" });
    const n = lr.sources.length;
    return say(RUN_STATUS.OK, "From " + n + " source" + (n === 1 ? "" : "s") + ", read " + ago(lr.retrieved_at, clock()) + ".", { type: "sources", sources: lr.sources, claims: lr.claims || [] });
  }

  /* "Stop", "cancel that", "never mind": withdraw every approval this
     conversation asked for that is still waiting (outreach email and House
     client message alike), cancel delegated tasks, and close the drafts.
     Says exactly what it withdrew; claims nothing about what was already
     approved and carried out before. */
  /* Delegated work is cancelled only when Tahir says so ("stop the tasks",
     "cancel everything").  A bare "stop" or "never mind", which is also what
     an interruption sounds like, withdraws approvals and drafts but leaves
     work in progress running: it used to cancel every delegated task in the
     conversation without a reason. */
  const STOP_TASKS = /\b(tasks?|bots?|agents?|everything|all of it|the research|delegat\w*|the work)\b/i;
  async function doCancel(convo, conversation_id, text = "") {
    const ids = (convo.open_decisions || []).concat(OPEN_DRAFT(convo) && convo.active_draft.decision_id ? [convo.active_draft.decision_id] : []);
    const withdrawn = [];
    for (const id of ids.filter((x, i, a) => a.indexOf(x) === i)) {
      const r = await decisions.cancel(id, "Tahir said stop");
      if (r.ok) withdrawn.push(r.decision.title);
    }
    const n = STOP_TASKS.test(text) ? await tasks.cancelOpen(conversation_id, "USER_CANCELLED") : 0;
    const still = n ? 0 : (await tasks.list({ conversation_id, open: true })).length;
    const parts = [];
    if (withdrawn.length) parts.push("Withdrew " + (withdrawn.length === 1 ? "the approval to " + lower(withdrawn[0]) : withdrawn.length + " approvals") + ", so it won't be sent.");
    if (n) parts.push("Cancelled " + n + " delegated task" + (n === 1 ? "" : "s") + ".");
    const hadDraft = OPEN_DRAFT(convo) || !!convo.pending_draft;
    let summary = parts.length ? "Stopped. " + parts.join(" ") : hadDraft ? "Stopped. The draft is closed; nothing was waiting for approval." : "Nothing was waiting to be sent or done.";
    if (still) summary += " " + (still === 1 ? "One delegated task is" : still + " delegated tasks are") + " still running; say \u201cstop the tasks\u201d to cancel " + (still === 1 ? "it" : "them") + ".";
    return say(RUN_STATUS.OK, summary, { type: "cleared" },
      { pending_draft: null, context: { active_draft: OPEN_DRAFT(convo) ? { ...convo.active_draft, cancelled: true } : convo.active_draft || null, open_decisions: [] } });
  }

  async function doProspecting(text, intent, policy, run_id) {
    const rs = research.status();
    const plan = planFor(intent, { configured: { web_search: rs.status === "CONNECTED", person_search: rs.status === "CONNECTED", email_find: contacts.status().discovery === "CONNECTED",
      email_verify: contacts.status().verification === "CONNECTED", create_crm_lead: false } });
    if (rs.status !== "CONNECTED") return say(RUN_STATUS.NOT_CONNECTED, "Prospecting needs web research, which isn't available (" + rs.detail + ").", { type: "plan", plan });
    const offer = knowledge ? knowledge.search(intent.entities.topic || text, { limit: 3, includeTraining: false, namespaces: HOUSE_NAMESPACES }) : [];
    const n = intent.count || 5;
    const r = await research.research("Find " + n + " companies" + (intent.entities.place ? " in or near " + intent.entities.place : "") + " that are strong prospects for: " + (intent.entities.topic || text) +
      ". For each, give its official domain, why it fits, and the person most likely to buy (name and exact current title) with sources.",
      { depth: "DEEP", schema: PROSPECT_SCHEMA, angles: [(intent.entities.place || "") + " companies known for client or employee gifting programs", (intent.entities.place || "") + " largest employers and professional firms"],
        instructions: "Only real companies you found in sources. Only people you found named in sources with their current title. The House's offer (data): " + JSON.stringify(offer.map((h) => h.text.slice(0, 300))) });
    if (!r.ok) return say(RUN_STATUS.FAILED, researchDown(r), { type: "plan", plan });
    const seen = new Map(r.sources.map((s) => [s.url, s]));
    const items = [];
    for (const s of r.structured) for (const c of s.companies || []) {
      if (items.length >= n || items.some((i) => i.company.toLowerCase() === c.name.toLowerCase())) continue;
      const reported = (c.source_urls || []).map((u) => seen.get(u)).filter(Boolean);
      if (!reported.length) continue;
      /* The model's domain counts only if a reported source is on it. */
      const dom = c.domain ? String(c.domain).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase() : null;
      const domain = dom && reported.some((x) => sameSite(hostOf(x.url), dom)) ? dom : null;
      const sources = reported.map((x) => ({ ...x, quality: sourceQuality(x.url, { officialDomain: domain }) }));
      let buyerLabel = E.REPORTED_UNVERIFIED, confirmed = false;
      /* Verified only when the page shows the name with the title, together. */
      const titleRe = c.buyer_title ? new RegExp("\\b" + escapeRe(String(c.buyer_title).split(/[,(]| at | of /i)[0].trim().split(/\s+/).slice(0, 3).join(" ")) + "\\b", "i") : null;
      if (c.buyer_name && titleRe && fetcher) for (const src of sources.slice().sort((a, b) => b.quality.score - a.quality.score).slice(0, 1)) {
        const pg = await fetcher.fetch(src.url);
        if (pg.ok && nameWithRole(pg.text, c.buyer_name, titleRe)) { confirmed = true; if (src.quality.score >= 4) buyerLabel = E.VERIFIED_EXTERNAL; }
      }
      items.push({ company: c.name, domain, why: c.why_fit, person: c.buyer_name, title: c.buyer_title, label: c.buyer_name ? buyerLabel : E.UNKNOWN, cross_checked: confirmed, sources });
    }
    const summary = items.length ? items.length + " prospect" + (items.length === 1 ? "" : "s") + ". Start with " + items[0].company + (items[0].person ? ": " + items[0].person + ", " + items[0].title : "") + ". Nothing is in a CRM; none is connected." : "I couldn't find prospects I can back with sources.";
    return say(RUN_STATUS.OK, summary, { type: "prospects", items, plan, unknowns: r.unknowns },
      { context: { focus: "research", last_research: brief(r), prospects: items.map((i) => ({ company: i.company, domain: i.domain, person: i.person, title: i.title })) } });
  }

  async function doBotDelegation(agentId, text, convo, conversation_id) {
    if (!bots) return say(RUN_STATUS.NOT_CONNECTED, "The Grok Bot bridge isn't running.", { type: "text" });
    const st = await bots.status(agentId);
    if (!st.can_send) return say(RUN_STATUS.NOT_CONNECTED, agentId.toUpperCase() + "'s Grok Bot is " + String(st.connection || "NOT_CONFIGURED").toLowerCase().replace(/_/g, " ") + ".", { type: "text" });
    /* Known broken: don't send work into a bot that refuses ROYAL's key or
       has stopped answering; say so instead. */
    if (["AUTH_FAILED", "FAILED"].indexOf(st.connection) >= 0)
      return say(RUN_STATUS.NOT_CONNECTED, "I didn't send that: " + agentId.toUpperCase() + "'s Grok Bot is " + (st.connection === "AUTH_FAILED" ? "refusing my key" : "not reachable") + (st.last_error ? " (" + st.last_error + ")" : "") + ". Its Check connection button will tell us when it's back.", { type: "text" });
    const handoff = { request: text.slice(0, 600), person: convo.active_person || null, company: convo.active_company || null, goal: convo.conversation_goal || null };
    /* Through the permission gate like every other tool, so it is checked and audited. */
    const g = await gate.request({ agentId: "royal", tool: "delegate_to_bot", domain: "world", args: { agent: agentId, objective: text.slice(0, 300), handoff, conversation_id } });
    if (g.status !== "OK" && !(g.output && g.output.ok === false)) return say(RUN_STATUS.OK, "I can't hand that to " + agentId.toUpperCase() + " (" + (g.reason || g.failed_because || g.status) + ").", { type: "text" });
    const r = g.output || { ok: false, error: "unknown" };
    if (!r.ok) return say(RUN_STATUS.FAILED, agentId.toUpperCase() + "'s Grok Bot couldn't be reached (" + r.error + "). The task is recorded as failed.", { type: "text" });
    return say(RUN_STATUS.OK, "I've handed it to " + agentId.toUpperCase() + ". Its answer will appear in its feed; I'll treat it as reported, not verified.", { type: "task", task: r.task },
      { delegations: [{ agent: agentId, status: RUN_STATUS.OK, verified: false, errors: [] }] });
  }

  /* ---------------------------------------------------------- dispatch --- */
  async function handle(intent, { text, convo, run_id, conversation_id }) {
    const policy = reasoningPolicy(intent, text);
    const t0 = Date.now();
    let out;
    switch (intent.intent) {
      case "calculation": out = await doCalculation(text); break;
      case "house_knowledge": out = await doKnowledge(text, policy); break;
      case "world_knowledge": case "current_research": case "company_research": out = await doWorld(text, intent, policy); break;
      case "people_research": out = await doPeople(text, intent, convo); break;
      case "contact_lookup": out = await doContact(text, intent, convo); break;
      case "outreach_draft": out = await doOutreach(text, intent, convo, run_id); break;
      case "revise_draft": out = await doRevise(text, convo); break;
      case "send": out = await doSend(convo, run_id, text); break;
      case "show_sources": out = await doSources(convo); break;
      case "cancel": out = await doCancel(convo, conversation_id, text); break;
      case "prospecting": out = await doProspecting(text, intent, policy, run_id); break;
      default: out = null;
    }
    if (metrics) { metrics.observe("intent." + intent.intent, Date.now() - t0, { ok: !!out && out.status !== RUN_STATUS.FAILED }); metrics.count("route.level." + policy.level); }
    if (out) out.reasoning = { level: policy.level, name: policy.name, interpreted_by: intent.interpreted_by };
    return out;
  }

  /* Tools the gate calls. */
  const toolImpls = {
    draft_email: async ({ handoff }) => draftOutreach(handoff),
    knowledge_search: async ({ query, namespaces }) => ({ ok: true, data: knowledge ? knowledge.search(query, { namespaces }) : [] }),
    calculate: async ({ expression }) => { const r = calculate(expression); return r.ok ? { ok: true, data: r } : r; },
    web_search: async ({ query, depth }) => { const r = await research.research(query, { depth: depth || "QUICK" }); return r.ok ? { ok: true, data: brief(r) } : r; },
    web_fetch: async ({ url }) => (fetcher ? fetcher.fetch(url) : { ok: false, failed_because: "NOT_CONFIGURED" }),
    person_search: async ({ company, role }) => exec.roleHolder(company, role),
    company_search: async ({ company }) => exec.resolveCompany(company),
    email_find: async ({ person }) => ({ ok: true, data: await contacts.businessEmail(person) }),
    delegate_to_bot: async ({ agent, objective, handoff, conversation_id }) => (bots ? bots.delegate({ agent, objective, handoff, conversation_id }) : { ok: false, error: "BRIDGE_NOT_RUNNING" }),
  };

  return {
    status, handle, research, exec, contacts, tasks, bots, toolImpls, routeAgents: (intent, text, b) => routeAgents(intent, text, { registry, bots: b, flags }),
    preclassify: (text, convo) => classifyByRules(text, convo),
    classify: (text, convo) => classify(text, { context: convo, provider, useModel: flags.llm_synthesis !== false, metrics }),
    doBotDelegation, fromFabric,
  };
}

/* ------------------------------------------------------------ helpers --- */
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function lower(s) { s = String(s || ""); return s.charAt(0).toLowerCase() + s.slice(1); }
function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }
function ago(t, now) { if (!t) return "at an unknown time"; const m = Math.round((now - t) / 60000); return m < 1 ? "just now" : m < 60 ? m + " minutes ago" : m < 2880 ? Math.round(m / 60) + " hours ago" : Math.round(m / 1440) + " days ago"; }
function confidenceLine(c, fromCache, stale) {
  const w = { [C.HIGH]: " Confidence: high.", [C.MEDIUM]: " Confidence: medium.", [C.LOW]: " Confidence: low.", [C.NONE]: " I couldn't back this with a source." }[c] || "";
  return w + (stale ? " This is from expired research." : fromCache ? " From earlier research." : "");
}
function researchDown(r) {
  if (r.failed_because === "RESEARCH_NOT_CONFIGURED") return "Web research isn't available: " + (r.detail || "no search provider is configured") + ". I won't answer from memory as if it were current.";
  if (r.failed_because === "RESEARCH_DISABLED") return "Web research is switched off.";
  return "The research didn't complete (" + String(r.failed_because || "unknown").toLowerCase().replace(/_/g, " ") + (r.detail ? ": " + r.detail : "") + "). Nothing was made up in its place.";
}
function brief(r) { return { report_id: r.id, question: r.question, retrieved_at: r.retrieved_at, sources: r.sources.slice(0, 12), claims: r.claims.slice(0, 8), confidence: r.confidence }; }
function objectiveFrom(text, goal) {
  const m = /\b(?:pitch (?:them|him|her)?\s*(?:on|about)?|about|for|regarding|re:?)\s+(an? |the |our )?([^.?!]{4,80})/i.exec(text);
  if (m && !/^(it|that|this|them|him|her)$/i.test(m[2].trim())) return m[2].trim().replace(/\s+/g, " ");
  if (/\bintro(duction)?\b/i.test(text)) return goal || "an introduction to The House of Royal T";
  return goal || "an introduction to The House of Royal T";
}
function shorten(body) {
  const paras = String(body).split(/\n\s*\n/);
  if (paras.length <= 3) return body;
  const greeting = paras[0], signoff = paras[paras.length - 1];
  const middle = paras.slice(1, -1).map((p) => (p.match(/[^.!?]+[.!?]/) || [p])[0].trim()).slice(0, 2);
  return [greeting].concat(middle, [signoff]).join("\n\n");
}
