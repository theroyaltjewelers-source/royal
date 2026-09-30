/* The intent grammar.  Turns what Tahir says into a structured intent:

     { verb, skill, agent, action, needs_entity, confidence, reason }

   verb is one of TELL, SHOW, OPEN, COMPARE, FOCUS, EXPLAIN, TRACE, HANDLE,
   WATCH, CLEAR, BACK, WHAT_CHANGED, WHAT_NEEDS_ME, STEP_AWAY, STATE, SEND,
   DELEGATE, MONEY, ASK.

   It is layered, not a flat keyword list:
     1. control verbs that change the conversation itself (clear, go back,
        send it, have <agent> do something);
     2. the verb frame ("show me", "open", "trace", "why") combined with what
        the conversation is already about;
     3. the existing topic rules (core/router.js) for the rest.
   Anything still unplaced is an open question for the language provider. */

import { route } from "./router.js";

const AGENTS = /\b(ace|grace|ledger|house|forge)\b/i;
const DELEGATE_VERB = /\b(have|ask|get|tell|let)\s+(ace|grace|ledger|house|forge)\b/i;
const DRAFT_WORDS = /\b(prepare|draft|write|put together|follow[\s-]?up|reach out|update|message|text|email|nudge|remind)\b/i;
const SEND = /^\s*(ok(ay)?[,.]?\s*|yes[,.]?\s*|go ahead[,.]?\s*)?(send (it|that|this|the (message|update|draft|reminder|email|intro|introduction))|go ahead and send( it)?|ship it)\b/i;
/* "Never mind" is a cancellation (core/intelligence/intent_engine.js), not
   just clearing the screen: it also withdraws anything waiting to be sent. */
const CLEAR = /^\s*(clear|reset|start over|that'?s all|dismiss)\b/i;
const BACK = /^\s*(go back|back|previous|undo that view)\b/i;
const OPEN = /\b(pull up|open|bring up|focus on|show me|look at|go to)\b/i;
const TRACE = /\b(trace|what'?s holding|holding (it|him|her|them|this) up|why (hasn'?t|has not|isn'?t|is not|did|is)|what'?s blocking|blocked)\b/i;
const MONEY = /\b(owe|owes|owed|balance|paid|pay(ment)?s?|outstanding|still due|how much)\b/i;
const CONTACT = /\b(last (talk|spoke|contact|heard|message)|when did we (last )?(talk|speak|hear|message))\b/i;

export function interpret(text, { entityResolved = false, entityStrong = false, entityFromConversation = false } = {}) {
  const t = String(text || "").trim();
  if (!t) return { verb: "ASK", skill: null, confidence: 0, reason: "EMPTY" };

  if (CLEAR.test(t)) return { verb: "CLEAR", skill: "clear", confidence: 0.95, reason: "CONTROL" };
  if (BACK.test(t)) return { verb: "BACK", skill: "go_back", confidence: 0.95, reason: "CONTROL" };
  if (SEND.test(t)) return { verb: "SEND", skill: "send_pending", confidence: 0.9, reason: "CONTROL" };

  const d = DELEGATE_VERB.exec(t);
  if (d && DRAFT_WORDS.test(t)) return { verb: "DELEGATE", skill: "delegate_draft", agent: d[2].toLowerCase(), action: "draft_client_update", needs_entity: true, confidence: 0.9, reason: "DELEGATION" };
  if (d) return { verb: "DELEGATE", skill: "delegate_draft", agent: d[2].toLowerCase(), action: "draft_client_update", needs_entity: true, confidence: 0.7, reason: "DELEGATION" };

  /* Follow-ups about the record under discussion. */
  if (entityResolved && (entityStrong || entityFromConversation)) {
    if (MONEY.test(t)) return { verb: "MONEY", skill: "project_money", needs_entity: true, confidence: 0.85, reason: "ENTITY_MONEY" };
    if (TRACE.test(t)) return { verb: "TRACE", skill: "project_status", needs_entity: true, confidence: 0.85, reason: "ENTITY_TRACE" };
    if (OPEN.test(t) || CONTACT.test(t)) return { verb: "OPEN", skill: "project_status", needs_entity: true, confidence: 0.85, reason: "ENTITY_OPEN" };
  }

  const r = route(t, { entityResolved, entityStrong });
  const verb = { what_needs_me: "WHAT_NEEDS_ME", can_i_step_away: "STEP_AWAY", state_of_house: "STATE", what_changed: "WHAT_CHANGED",
    handle_it: "HANDLE", project_status: "OPEN", open_question: "ASK" }[r.skill] || (/\bshow\b/i.test(t) ? "SHOW" : "TELL");
  return { verb, skill: r.skill, confidence: r.confidence, reason: r.reason };
}

export function mentionsAgent(text) { const m = AGENTS.exec(String(text || "")); return m ? m[1].toLowerCase() : null; }
