/* The ROYAL presentation contract.

   ROYAL decides WHAT appears; the interface decides HOW it looks.  A
   presentation spec names primitives from this fixed vocabulary and carries
   plain data for them.  Nothing in a spec is executable: no HTML, no code,
   no URLs to load.  The server validates every spec before sending it and
   the browser validates it again before drawing it.

   Shared by the server (core/composer.js) and the browser (web/js), so the
   two can never disagree about what a primitive is. */

export const SPEC_VERSION = 1;

export const MODES = ["ambient", "answer", "exceptions", "focus", "money", "production", "timeline", "decision",
  "clarify", "draft", "systems", "step_away", "state", "not_connected", "error", "back", "research", "knowledge", "person", "plan"];

const S = (max = 2000) => ({ t: "string", max });
const N = { t: "number" };
const B = { t: "boolean" };
const OPT = (x) => ({ ...x, optional: true });
const ARR = (of, max = 50) => ({ t: "array", of, max });
const OBJ = (fields) => ({ t: "object", fields });

const EVIDENCE = OBJ({ label: S(40), source: OPT(S(80)), age: OPT(S(80)), note: OPT(S(300)) });
const ENTITY = OBJ({ type: OPT(S(20)), id: OPT(S(80)), name: OPT(S(200)), client_name: OPT(S(200)), client_id: OPT(S(80)), stage: OPT(S(60)) });

/* One item shape serves risks, receivables, commitments, waiting items and
   leads: what differs is how the primitive draws it. */
const ITEM = OBJ({
  id: OPT(S(120)), title: S(300), detail: OPT(S(1000)), priority: OPT(S(4)), risk: OPT(S(8)), need: OPT(S(12)),
  owner: OPT(S(120)), next_action: OPT(S(500)), amount: OPT(N), entity: OPT(ENTITY), evidence: OPT(EVIDENCE), code: OPT(S(60)),
});

/* A source is shown, never loaded: the page draws a link only to http(s). */
const SOURCE = OBJ({ title: OPT(S(300)), domain: S(200), url: OPT(S(800)), retrieved: OPT(S(80)), kind: OPT(S(40)), confirmed: OPT(B) });
const CLAIM = OBJ({ text: S(600), label: S(40), confidence: OPT(S(10)), sources: ARR(SOURCE, 6), note: OPT(S(600)) });

export const PRIMITIVES = {
  STATEMENT:          OBJ({ text: S(2000), tone: OPT(S(12)), evidence: OPT(EVIDENCE) }),
  ENTITY_CORE:        OBJ({ entity: ENTITY, facts: ARR(OBJ({ k: S(60), v: S(500), label: OPT(S(40)), source: OPT(S(80)), age: OPT(S(80)) }), 20),
                            unknown: OPT(ARR(S(300), 10)), owner: OPT(S(120)), next_action: OPT(S(500)), deadline: OPT(S(40)), risk: OPT(S(8)), why: OPT(S(1500)) }),
  RISK_OBJECT:        ITEM,
  RECEIVABLE_OBJECT:  ITEM,
  COMMITMENT_OBJECT:  ITEM,
  WAITING_OBJECT:     ITEM,
  LEAD_OBJECT:        ITEM,
  DECISION_OBJECT:    OBJ({ id: S(80), type: S(40), title: S(300), status: S(20), priority: OPT(S(4)), risk: OPT(S(8)), why: OPT(S(1000)),
                            requested_by: OPT(S(40)), source: OPT(S(80)), expected_result: OPT(S(500)), financial_impact: OPT(N),
                            reversibility: OPT(S(40)), deadline: OPT(S(40)), facts: OPT(ARR(S(500), 10)), unknowns: OPT(ARR(S(300), 10)),
                            draft: OPT(S(4000)), execution: OPT(S(500)), if_we_wait: OPT(S(500)) }),
  MONEY_FLOW:         OBJ({ headline: S(200), total: OPT(N), parts: ARR(OBJ({ label: S(120), amount: N, sub: OPT(S(200)), entity: OPT(ENTITY), evidence: OPT(EVIDENCE) }), 12), evidence: OPT(EVIDENCE) }),
  PRODUCTION_FLOW:    OBJ({ stages: ARR(OBJ({ stage: S(60), count: N, attention: N }), 12), healthy: N }),
  TIMELINE:           OBJ({ basis: OPT(S(120)), events: ARR(OBJ({ text: S(500), tone: OPT(S(12)) }), 40) }),
  CLEAR_STATE:        OBJ({ clear: B, checked: ARR(S(120), 12), not_checked: ARR(S(200), 12) }),
  SYSTEM_HEALTH:      OBJ({ systems: ARR(OBJ({ name: S(120), on: B, detail: OPT(S(200)) }), 20) }),
  MESSAGE_VIEW:       OBJ({ to: S(200), purpose: S(200), body: S(4000), by: OPT(S(40)), label: S(40), subject: OPT(S(200)), address: OPT(S(200)),
                            address_status: OPT(S(40)), method: OPT(S(20)) }),
  RESEARCH_OBJECT:    OBJ({ question: S(1000), answer: S(2000), confidence: S(10), claims: ARR(CLAIM, 10), conflicts: ARR(S(800), 5), unknowns: ARR(S(300), 8),
                            sources: ARR(SOURCE, 12), retrieved: OPT(S(80)), note: OPT(S(300)) }),
  PERSON_OBJECT:      OBJ({ name: OPT(S(160)), title: OPT(S(200)), role: OPT(S(80)), company: S(200), domain: OPT(S(200)), since: OPT(S(40)), label: S(40),
                            confidence: OPT(S(10)), confirmed_on: OPT(S(200)), email: OPT(S(200)), email_status: OPT(S(40)), email_note: OPT(S(500)),
                            others: ARR(OBJ({ name: S(160), title: S(200), note: OPT(S(200)) }), 6), conflict: OPT(S(800)), sources: ARR(SOURCE, 8) }),
  KNOWLEDGE_OBJECT:   OBJ({ answer: OPT(S(1500)), label: S(40), passages: ARR(OBJ({ citation: S(300), text: S(1000), status: OPT(S(20)), binding: OPT(B), synthetic: OPT(B) }), 5),
                            unknowns: ARR(S(300), 4) }),
  PROSPECT_LIST:      OBJ({ items: ARR(OBJ({ company: S(160), domain: OPT(S(160)), why: OPT(S(400)), person: OPT(S(160)), title: OPT(S(200)), label: S(40), sources: ARR(SOURCE, 4) }), 10),
                            note: S(400) }),
  PLAN_OBJECT:        OBJ({ goal: S(200), steps: ARR(OBJ({ text: S(300), requires: S(20), available: B }), 20) }),
  SOURCE_LIST:        OBJ({ sources: ARR(SOURCE, 20), claims: ARR(CLAIM, 8) }),
  TASK_OBJECT:        OBJ({ agent: S(40), objective: S(500), status: S(30), created: OPT(S(80)) }),
  SEARCH_RESULTS:     OBJ({ prompt: S(300), candidates: ARR(OBJ({ id: S(80), name: OPT(S(200)), client_name: OPT(S(200)), stage: OPT(S(60)) }), 12) }),
  ACTION_CONFIRMATION:OBJ({ text: S(1000), done: N, pending: N, refused: N }),
  NOT_CONNECTED:      OBJ({ what: S(200), detail: OPT(S(500)), domains: OPT(ARR(OBJ({ name: S(120), description: OPT(S(300)) }), 12)) }),
  ERROR_OBJECT:       OBJ({ attempted: S(300), failed_because: S(500), impact: OPT(S(500)), retryable: OPT(B), next_action: OPT(S(300)) }),
  UNKNOWN_OBJECT:     OBJ({ text: S(500) }),
};

export const AGENT_STATES = ["delegated", "reported", "did_not_report", "not_connected"];

function check(schema, v, path, errors) {
  if (v === undefined || v === null) { if (!schema.optional) errors.push(path + " is required"); return; }
  switch (schema.t) {
    case "string": if (typeof v !== "string") errors.push(path + " must be text"); else if (v.length > schema.max) errors.push(path + " is too long"); return;
    case "number": if (typeof v !== "number" || !isFinite(v)) errors.push(path + " must be a number"); return;
    case "boolean": if (typeof v !== "boolean") errors.push(path + " must be true or false"); return;
    case "array":
      if (!Array.isArray(v)) { errors.push(path + " must be a list"); return; }
      if (v.length > schema.max) errors.push(path + " has too many entries");
      v.slice(0, schema.max).forEach((x, i) => check(schema.of, x, path + "[" + i + "]", errors)); return;
    case "object":
      if (typeof v !== "object" || Array.isArray(v)) { errors.push(path + " must be an object"); return; }
      for (const k of Object.keys(v)) if (!schema.fields[k]) errors.push(path + "." + k + " is not a known field");
      for (const [k, f] of Object.entries(schema.fields)) check(f, v[k], path + "." + k, errors);
      return;
  }
}

/* Returns {ok, spec, rejected}.  A primitive that fails its schema is
   dropped, never "repaired", and counted in `rejected` with the reason. */
export function validateSpec(spec) {
  const errors = [], rejected = [];
  if (!spec || typeof spec !== "object") return { ok: false, errors: ["spec is not an object"], rejected };
  if (spec.version !== SPEC_VERSION) errors.push("unknown spec version");
  if (MODES.indexOf(spec.mode) < 0) errors.push("unknown mode " + JSON.stringify(spec.mode));
  if (typeof spec.speech !== "string" || spec.speech.length > 1200) errors.push("speech must be text under 1200 characters");
  if (!Array.isArray(spec.surfaces) || spec.surfaces.length > 16) errors.push("surfaces must be a list of at most 16");
  if (!Array.isArray(spec.agents) || spec.agents.length > 16) errors.push("agents must be a list of at most 16");
  if (errors.length) return { ok: false, errors, rejected };
  const surfaces = [];
  spec.surfaces.forEach((s, i) => {
    const e = [];
    if (!s || typeof s !== "object" || !PRIMITIVES[s.type]) e.push("unknown primitive " + JSON.stringify(s && s.type));
    else check(PRIMITIVES[s.type], s.data, "surfaces[" + i + "].data", e);
    if (e.length) rejected.push({ index: i, type: s && s.type, errors: e.slice(0, 5) }); else surfaces.push({ type: s.type, data: s.data });
  });
  const agents = spec.agents.filter((a) => a && typeof a.id === "string" && a.id.length < 40 && AGENT_STATES.indexOf(a.state) >= 0)
    .map((a) => ({ id: a.id, name: String(a.name || a.id).slice(0, 40), state: a.state }));
  return { ok: true, rejected, spec: { version: SPEC_VERSION, mode: spec.mode, realm: spec.realm === "PERSONAL" ? "PERSONAL" : "BUSINESS",
    tone: ["calm", "attention", "alert"].indexOf(spec.tone) >= 0 ? spec.tone : "calm", speech: spec.speech,
    focus_entity: spec.focus_entity && typeof spec.focus_entity.id === "string" ? { type: "project", id: spec.focus_entity.id.slice(0, 80) } : null,
    agents, surfaces } };
}
