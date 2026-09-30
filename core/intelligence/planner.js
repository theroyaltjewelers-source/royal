/* The Planning Engine: breaking a goal into work.

   A plan is a list of steps, each naming the capability it needs (a tool, a
   research call, an agent) and its dependencies.  Plans come from templates
   for goals ROYAL knows how to pursue; a model may later propose plans
   through the same schema, validated the same way.

   A plan grants no authority.  Every step that would act still goes through
   the permission engine when it runs, and a step whose tool needs approval
   becomes a Decision, not an action. */

import { TOOL_POLICY } from "../permissions.js";
import { PERMISSION as P } from "../enums.js";

const TEMPLATES = {
  prospecting: (intent) => ({
    goal: intent.goal || "qualified prospects",
    steps: [
      { id: "offer", do: "knowledge_search", args: { query: intent.entities.topic || "corporate gifting offer" }, why: "Understand what the House actually offers for this." },
      { id: "criteria", do: "reason", after: ["offer"], why: "Decide what makes a company a good fit." },
      { id: "candidates", do: "web_search", after: ["criteria"], args: { count: intent.count || 5, place: intent.entities.place }, why: "Find candidate companies." },
      { id: "buyers", do: "person_search", after: ["candidates"], why: "Identify the likely buyer at each company and confirm they hold the role now." },
      { id: "contacts", do: "email_find", after: ["buyers"], optional: true, why: "Find a professional email where a configured provider allows." },
      { id: "verify", do: "email_verify", after: ["contacts"], optional: true, why: "Classify deliverability." },
      { id: "records", do: "create_crm_lead", after: ["buyers"], optional: true, why: "Prepare prospect records; creating them needs a CRM and approval." },
      { id: "synthesis", do: "reason", after: ["buyers"], why: "Rank and explain who to contact first." },
    ],
  }),
  executive_contact: (intent) => ({
    goal: "identify and contact a business executive",
    steps: [
      { id: "company", do: "company_search", args: { company: intent.entities.company }, why: "Resolve the exact company and its domain." },
      { id: "person", do: "person_search", after: ["company"], args: { role: intent.entities.role }, why: "Find who holds the role now." },
      { id: "email", do: "email_find", after: ["person"], optional: true, why: "Find a business email." },
      { id: "verify", do: "email_verify", after: ["email"], optional: true, why: "Classify deliverability." },
    ],
  }),
  outreach: () => ({
    goal: "send a first outreach",
    steps: [
      { id: "handoff", do: "reason", why: "Assemble the structured handoff for ACE." },
      { id: "draft", do: "draft_email", after: ["handoff"], why: "ACE drafts." },
      { id: "send", do: "send_email", after: ["draft"], why: "Send, only after Tahir approves the exact message." },
      { id: "lead", do: "create_crm_lead", after: ["send"], optional: true, why: "Record the prospect, if a CRM is connected." },
    ],
  }),
};

const KNOWN = new Set(["reason", ...Object.keys(TOOL_POLICY)]);

export function validatePlan(plan) {
  const errors = [], ids = new Set();
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return { ok: false, errors: ["a plan needs steps"] };
  if (plan.steps.length > 20) errors.push("too many steps");
  for (const s of plan.steps) {
    if (!s.id || ids.has(s.id)) errors.push("step ids must be unique");
    if (!KNOWN.has(s.do)) errors.push("unknown capability " + s.do);
    for (const a of s.after || []) if (!ids.has(a)) errors.push(s.id + " depends on a later or unknown step " + a);
    ids.add(s.id);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

/* Annotate each step with what the permission engine will require, so the
   plan can say honestly which steps ROYAL can do and which need Tahir. */
export function annotate(plan, { configured = {} } = {}) {
  return { ...plan, steps: plan.steps.map((s) => {
    const pol = TOOL_POLICY[s.do];
    const needs = !pol ? "none" : pol.cls === P.APPROVAL_REQUIRED ? "approval" : pol.cls === P.PROHIBITED ? "prohibited" : pol.cls === P.INTERNAL_WRITE ? "internal_write" : "none";
    const available = configured[s.do] === undefined ? true : !!configured[s.do];
    return { ...s, requires: needs, available };
  }) };
}

export function planFor(intent, { configured = {} } = {}) {
  const t = intent.intent === "prospecting" ? "prospecting" : intent.intent === "people_research" || intent.intent === "contact_lookup" ? "executive_contact" : intent.intent === "outreach_draft" ? "outreach" : null;
  if (!t) return null;
  const plan = TEMPLATES[t](intent);
  const v = validatePlan(plan);
  if (!v.ok) throw new Error("PLAN_INVALID: " + v.errors.join("; "));
  return annotate({ template: t, ...plan }, { configured });
}
