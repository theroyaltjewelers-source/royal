/* The reasoning router: how much thinking a request deserves.

   Not every request goes down the same path.  The level decides whether a
   model is used at all, which model, how deep research goes, how many tokens
   an answer may use, and whether agents or planning are involved.

     0 DIRECT_RETRIEVAL     read authoritative data, no model   ("What does Marcus owe?")
     1 QUICK                arithmetic, a policy, a stable fact ("12% of $85,000")
     2 OPERATIONAL          several House facts together        ("Why is this project behind?")
     3 DEEP                 many variables, trade-offs          ("Sequence these obligations")
     4 AGENTIC_RESEARCH     search, resolve, cross-check        ("Find the CFO of X")
     5 EXECUTION_PLANNING   decompose, delegate, act, verify    ("Handle it", prospect lists) */

import { REASONING_LEVEL as L } from "../enums.js";

const BY_INTENT = {
  house_state: L.DIRECT_RETRIEVAL, house_record: L.DIRECT_RETRIEVAL, calculation: L.QUICK, show_sources: L.DIRECT_RETRIEVAL, cancel: L.DIRECT_RETRIEVAL,
  house_knowledge: L.QUICK, world_knowledge: L.QUICK, revise_draft: L.QUICK, send: L.DIRECT_RETRIEVAL,
  outreach_draft: L.OPERATIONAL, delegate: L.OPERATIONAL,
  current_research: L.AGENTIC_RESEARCH, company_research: L.AGENTIC_RESEARCH, people_research: L.AGENTIC_RESEARCH, contact_lookup: L.AGENTIC_RESEARCH,
  prospecting: L.EXECUTION_PLANNING, unknown: L.OPERATIONAL, personal: L.DIRECT_RETRIEVAL,
};
const WHY = /\b(why|what'?s (holding|blocking)|explain|cause|behind|late)\b/i;
const DEEP = /\b(sequence|prioriti[sz]e|trade-?offs?|should (we|i)|best way|strategy|plan for|without hurting|scenario)\b/i;

export function reasoningPolicy(intent, text = "") {
  let level = BY_INTENT[intent.intent] ?? L.OPERATIONAL;
  if (intent.intent === "house_record" && WHY.test(text)) level = L.OPERATIONAL;
  if ((intent.intent === "unknown" || intent.intent === "world_knowledge") && DEEP.test(text)) level = L.DEEP;
  const name = Object.keys(L).find((k) => L[k] === level);
  return {
    level, name,
    use_model: level >= L.QUICK && intent.intent !== "calculation" && intent.intent !== "show_sources" && intent.intent !== "cancel",
    model_tier: level <= L.QUICK ? "fast" : "reasoning",
    research_depth: level >= L.EXECUTION_PLANNING ? "DEEP" : level === L.AGENTIC_RESEARCH ? (intent.research_depth || "STANDARD") : null,
    max_tokens: [300, 400, 700, 1200, 1200, 1600][level],
    allow_search: level >= L.AGENTIC_RESEARCH || !!intent.needs_current_web,
    allow_agents: level >= L.OPERATIONAL,
    plan: level >= L.EXECUTION_PLANNING,
  };
}
