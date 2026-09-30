/* Intent routing.  Deterministic first: the questions Tahir asks most have
   exact answers computed from records, and those should never depend on a
   model being awake.  Anything the rules cannot place goes to the language
   provider when one is connected, and is said plainly when one is not.

   Rules are ordered: the first match wins. */

export const INTENTS = [
  { skill: "handle_it",         re: /^\s*(royal,?\s*)?(handle it|take care of (it|that|this)|deal with (it|that))\b/i },
  { skill: "personal",          re: /\b(my (calendar|schedule|wealth|net worth|portfolio|personal)|personal (tasks?|finances?)|appointments? (today|tomorrow)|what'?s on my calendar)\b/i },
  { skill: "other_business",    re: /\b(tahir\s*(&|and)\s*co|gold\s*buy)\b/i },
  { skill: "can_i_step_away",   re: /\b(step away|stepping away|can i (leave|go|log off|take (the|a) (day|afternoon|evening|night) off)|take the rest of the day|am i clear)\b/i },
  { skill: "state_of_house",    re: /\b(state of the house|how('?s| is) the house|house (status|report)|give me the (overview|picture)|where do we stand)\b/i },
  { skill: "morning_briefing",  re: /\b(brief(ing)?|morning|get me ready|ready for (tomorrow|today|the day)|start (my|the) day|end of (the )?day)\b/i },
  { skill: "decisions_open",    re: /\b(approv(e|al|als)|decisions?|sign off|waiting on me to decide)\b/i },
  { skill: "what_changed",      re: /\b(what('?s| has)? changed|what'?s new|what happened|any changes|since (yesterday|this morning|last time))\b/i },
  { skill: "what_needs_me",     re: /\b(what needs me|needs? (me|my attention)|what should i (do|focus|look at)|anything for me|triage|what do i need to)\b/i },
  { skill: "who_owes_us",       re: /\b(owe|owes|owed|receivables?|outstanding|unpaid|who hasn'?t paid|collect(ions?)?|balances?)\b/i },
  { skill: "waiting_for",       re: /\b(waiting (on|for)|blocked|stuck|holding (us )?up)\b/i },
  { skill: "commitments",       re: /\b(promis(e|es|ed)|commitments?|due (today|tomorrow|this week)|deadlines?)\b/i },
  { skill: "revenue_leakage",   re: /\b(leak(age)?|margin|losing money|underpriced|below (the )?floor)\b/i },
  { skill: "clients_at_risk",   re: /\b(clients? (are |is )?at risk|at[- ]risk|which clients)\b/i },
  { skill: "sales_pipeline",    re: /\b(leads?|pipeline|inquir(y|ies)|prospects?|sales)\b/i },
  { skill: "system_status",     re: /\b(systems?|connect(ed|ion)?|integrations?|sync|health|forge|is (royal|the calculator) (working|connected))\b/i },
  { skill: "production_status", re: /\b(production|manufactur(er|ing)|cad|setting|quality control|qc|in the shop|pickups?)\b/i },
];

/* Words that turn a question into one about a particular record. */
const ABOUT_ENTITY = /\b(status|where is|where'?s|why (hasn'?t|has not|isn'?t|is not|did|is)|what'?s (happening|going on) with|how is|update on|tell me about|show me)\b/i;

export function route(text, { entityResolved = false, entityStrong = entityResolved } = {}) {
  const t = String(text || "").trim();
  if (!t) return { skill: null, confidence: 0, reason: "EMPTY" };
  if (entityResolved && ABOUT_ENTITY.test(t)) return { skill: "project_status", confidence: 0.9, reason: "ENTITY_QUESTION" };
  for (const r of INTENTS) if (r.re.test(t)) return { skill: r.skill, confidence: 0.85, reason: "RULE" };
  if (entityResolved && entityStrong) return { skill: "project_status", confidence: 0.6, reason: "ENTITY_ONLY" };
  return { skill: "open_question", confidence: 0.3, reason: "NO_RULE" };
}
