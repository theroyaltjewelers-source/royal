/* Intent routing.  Deterministic first: the questions Tahir asks most have
   exact answers computed from records, and those should never depend on a
   model being awake.  Anything the rules cannot place goes to the language
   provider when one is connected, and is said plainly when one is not.

   Rules are ordered: the first match wins. */

import { fastPath } from "./identity.js";
import { definitionQuery } from "./house_language.js";

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
  { skill: "cash_analysis",     re: /\b(tight on cash|cash (flow|position|crunch|is tight|has been tight|been tight|situation)|(low|short|light) on cash|where('?s| is| did) (the|our|all the) (cash|money)( go(ne)?)?|why (is|are|has|have) (we|cash|money) (been )?(so )?(tight|short|low)|how('?s| is) (our )?cash)\b/i },
  { skill: "who_owes_us",       re: /\b(owe|owes|owed|receivables?|outstanding|unpaid|who hasn'?t paid|collect(ions?)?|balances?)\b/i },
  { skill: "waiting_for",       re: /\b(waiting (on|for)|blocked|stuck|holding (us )?up)\b/i },
  { skill: "commitments",       re: /\b(promis(e|es|ed)|commitments?|due (today|tomorrow|this week)|deadlines?)\b/i },
  { skill: "revenue_leakage",   re: /\b(leak(age)?|margin|losing money|underpriced|below (the )?floor)\b/i },
  { skill: "clients_at_risk",   re: /\b(clients? (are |is )?at risk|at[- ]risk|which clients)\b/i },
  { skill: "sales_pipeline",    re: /\b(leads?|pipeline|inquir(y|ies)|prospects?|sales(?! tax))\b/i },   /* "sales tax" is a tax question, not the pipeline */
  { skill: "system_status",     re: /\b(systems?|connect(ed|ion)?|integrations?|sync|health|forge|is (royal|the calculator) (working|connected))\b/i },
  { skill: "production_status", re: /\b(production|manufactur(er|ing)|cad|setting|quality control|qc|in the shop|pickups?)\b/i },
];

/* Questions about ROYAL's own team and work.  They are answered from ROYAL's
   own records: before these rules, "what did each bot do today" was read as
   a current-events question ("today") and sent to web research. */
const TEAM = /\b(bots?|agents?|specialists?|(ai |my )?team|ace|grace|ledger|forge|house (bot|agent))\b/i;
const HOUSE_AGENT = /\bHOUSE\b/;   /* the agent is written in capitals; "the house" is the House */
const WORKED = /\b(do|did|done|doing|work(ed|ing)?|accomplish(ed)?|complete(d)?|handle(d)?|finish(ed)?|report(ed)?|been up to|activity|productive)\b/i;
const ACTIVE = /\b(what are you (working on|doing|running)|what('?s| is) (running|in progress|still going)|anything (running|in progress)|what('?s| is) (everyone|the team) (working on|doing))\b/i;
export const DIAGNOSE = /\b(diagnose yourself|self[- ]?diagnos\w*|run (a |your )?diagnostics?|what systems are (actually )?working|which systems are (actually )?working|is everything (actually )?working|are (all )?(your|the) systems (working|up|ok|healthy))\b/i;

/* A question about a concept ("what's the difference between gross margin
   and cash flow", "how does A/R affect cash") goes to knowledge first, even
   when it contains a House word like margin or leads; one naming a record
   stays with the House. */
export const CONCEPT = /^\s*(what('?s| is| are) (the )?difference between|what('?s| is| are) (an? )?[a-z/&-]+( [a-z/&-]+){0,3}\s*\??\s*$|how (does|do) [^?]+ (affect|relate to|relate|work|differ)|explain (what|how)|define\b|how should (we|i) (think about|qualify|forecast|measure|price|prioriti[sz]e|decide)|when should (we|i) use)/i;

/* Words that make a "what is" question about the House, not a concept. */
const HOUSEISH = /\b(our|my|this (week|month)|today|right now|owe[sd]?|happening|going on|changed|new|due|next|waiting|pending|left|status|stage|policy|policies|house|warranty|standard|process|needs?)\b/i;

export function teamRoute(t) {
  if (DIAGNOSE.test(t)) return "self_diagnostic";
  if (ACTIVE.test(t)) return "active_work";
  if ((TEAM.test(t) || HOUSE_AGENT.test(t)) && WORKED.test(t) && !/^\s*(have|ask|get|tell|let) (ace|grace|ledger|forge|house)\b/i.test(t)) return "agent_activity";
  return null;
}

/* Words that turn a question into one about a particular record. */
const ABOUT_ENTITY = /\b(status|where is|where'?s|why (hasn'?t|has not|isn'?t|is not|did|is)|what'?s (happening|going on) with|how is|update on|tell me about|show me)\b/i;

export function route(text, { entityResolved = false, entityStrong = entityResolved } = {}) {
  const t = String(text || "").trim();
  if (!t) return { skill: null, confidence: 0, reason: "EMPTY" };
  /* The fast path: a greeting, "who are you", thanks, or what a House word
     means.  Answered from ROYAL's identity and the House language, with no
     model call, so they come back at once. */
  const fp = fastPath(t);
  if (fp) return { skill: fp, confidence: 0.95, reason: "FAST_PATH" };
  if (definitionQuery(t)) return { skill: "house_term", confidence: 0.9, reason: "FAST_PATH" };
  const tr = teamRoute(t);
  if (tr) return { skill: tr, confidence: 0.9, reason: "LEDGER" };
  if (!entityResolved && CONCEPT.test(t) && !HOUSEISH.test(t)) return { skill: "open_question", confidence: 0.7, reason: "CONCEPT" };
  if (entityResolved && ABOUT_ENTITY.test(t)) return { skill: "project_status", confidence: 0.9, reason: "ENTITY_QUESTION" };
  for (const r of INTENTS) if (r.re.test(t)) return { skill: r.skill, confidence: 0.85, reason: "RULE" };
  if (entityResolved && entityStrong) return { skill: "project_status", confidence: 0.6, reason: "ENTITY_ONLY" };
  return { skill: "open_question", confidence: 0.3, reason: "NO_RULE" };
}
