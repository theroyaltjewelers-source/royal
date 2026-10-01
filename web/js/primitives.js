/* The primitive renderer.  Each primitive in web/js/schema.js has exactly one
   drawing here.  Everything is escaped; nothing from a spec is ever
   interpreted as markup.  Interactions are declared with data attributes and
   handled centrally (web/js/app.js):

     data-q="..."        ask ROYAL this, as if Tahir had said it
     data-res="APPROVE"  resolve the decision this object belongs to
     data-edit           turn the decision's draft into an editable field

   Evidence is always visible in a quiet line, and inference never looks like
   verified fact: it is italic, dotted, and says "Inferred". */

export const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const money = (n) => (n < 0 ? "-$" : "$") + Math.abs(Math.round(Number(n) || 0)).toLocaleString("en-US");

const RISK = { GREEN: "Healthy", YELLOW: "Watch", ORANGE: "At risk", RED: "Serious", BLACK: "Critical" };
const NEED = { KNOW: "For you to know", DECIDE: "Needs your decision", APPROVE: "Needs your approval", DO: "Needs action", DELEGATE: "Can be delegated", MONITOR: "Watching", NONE: "" };
const LABEL = { VERIFIED: "Verified", VERIFIED_INTERNAL: "Verified in House records", VERIFIED_EXTERNAL: "Verified at the source", REPORTED_UNVERIFIED: "Reported, not verified",
  MODEL_KNOWLEDGE: "General knowledge, not checked", INFERENCE: "Inferred", RECOMMENDATION: "Recommendation", UNKNOWN: "Unknown" };
const EMAIL = { PUBLICLY_LISTED: "Published by the company", PROVIDER_FOUND: "Found by a provider, not verified", PATTERN_INFERRED: "Guessed from the company's pattern, not verified",
  VERIFIED_DELIVERABLE: "Verified deliverable", LIKELY_DELIVERABLE: "Likely deliverable (pattern)", RISKY: "Risky", INVALID: "Invalid, do not use", UNVERIFIED: "Not verified", NOT_FOUND: "Not found" };
const CONF = { HIGH: "high confidence", MEDIUM: "medium confidence", LOW: "low confidence", NONE: "no support" };
const safeUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u || "")) ? String(u) : null);
function src(x) {
  const u = safeUrl(x.url), label = esc(x.title || x.domain);
  return '<li class="src' + (x.confirmed ? " ok" : "") + '">' + (u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer nofollow">' + label + "</a>" : label) +
    ' <span>' + esc(x.domain) + (x.kind ? " · " + esc(String(x.kind).replace(/_/g, " ")) : "") + (x.retrieved ? " · read " + esc(x.retrieved) : "") + (x.confirmed ? " · confirmed by ROYAL" : "") + "</span></li>";
}
function sources(list, title = "Sources") { return list && list.length ? '<details class="srcs"><summary>' + esc(title) + " (" + list.length + ")</summary><ul>" + list.map(src).join("") + "</ul></details>" : ""; }
function claimLi(c) { return '<li class="claim">' + esc(c.text) + ev({ label: c.label, note: [c.confidence ? CONF[c.confidence] || c.confidence : null].filter(Boolean).join("") }) + sources(c.sources, "Sources") + "</li>"; }
const KIND = { RISK_OBJECT: "Attention", RECEIVABLE_OBJECT: "Money owed", COMMITMENT_OBJECT: "Promise", WAITING_OBJECT: "Waiting", LEAD_OBJECT: "Lead" };

function ev(e) {
  if (!e || !e.label) return "";
  return '<p class="ev ev-' + esc(e.label) + '"><span class="evl">' + esc(LABEL[e.label] || e.label) + "</span>" +
    (e.source ? " · " + esc(e.source) : "") + (e.age ? " · " + esc(e.age) : "") + (e.note ? " · " + esc(e.note) : "") + "</p>";
}
function risk(r) { return r ? '<span class="rk rk-' + esc(r) + '"><i aria-hidden="true"></i>' + esc(RISK[r] || r) + "</span>" : ""; }
function openQ(e) { return e && e.id ? ' data-q="Pull up ' + esc(e.id) + '"' : ""; }

function item(type, d, i) {
  const e = d.entity || {};
  return '<article class="obj it rk-' + esc(d.risk || "GREEN") + (i === 0 && d.priority === "P1" ? " lead" : "") + '" tabindex="-1">' +
    '<header class="obj-h"><span class="kind">' + esc(KIND[type] || "Item") + "</span>" + risk(d.risk) +
    (d.need && NEED[d.need] ? '<span class="need">' + esc(NEED[d.need]) + "</span>" : "") +
    (typeof d.amount === "number" ? '<span class="amt">' + money(d.amount) + "</span>" : "") + "</header>" +
    '<h3 class="obj-t">' + esc(d.title) + "</h3>" +
    (e.client_name || e.name ? '<p class="who">' + esc([e.client_name, e.name].filter(Boolean).join(" · ")) + "</p>" : "") +
    (d.detail ? '<p class="det">' + esc(d.detail) + "</p>" : "") +
    (d.next_action ? '<p class="next"><b>Next</b> ' + esc(d.next_action) + (d.owner ? ' <span class="own">' + esc(d.owner) + "</span>" : "") + "</p>" : "") +
    '<footer class="obj-f">' + ev(d.evidence) + (e.id ? '<button type="button" class="lnk"' + openQ(e) + ">Open</button>" : "") + "</footer></article>";
}

const R = {
  STATEMENT: (d) => '<article class="obj stmt tone-' + esc(d.tone || "calm") + '"><p class="stmt-t">' + esc(d.text) + "</p>" + ev(d.evidence) + "</article>",

  ENTITY_CORE: (d) => {
    const e = d.entity || {};
    return '<article class="obj entity rk-' + esc(d.risk || "GREEN") + '">' +
      '<p class="eyebrow">' + esc([e.id, e.client_name].filter(Boolean).join(" · ")) + "</p>" +
      '<h2 class="entity-t">' + esc(e.name || "Untitled") + "</h2>" +
      '<p class="entity-s"><span class="stage">' + esc(e.stage || "") + "</span>" + risk(d.risk) + (d.deadline ? '<span class="due">Target ' + esc(d.deadline) + "</span>" : "") + "</p>" +
      (d.why ? '<p class="why"><b>Why</b> ' + esc(d.why) + "</p>" : "") +
      (d.next_action ? '<p class="next"><b>Next</b> ' + esc(d.next_action) + (d.owner ? ' <span class="own">' + esc(d.owner) + "</span>" : "") + "</p>" : "") +
      '<ul class="facts">' + (d.facts || []).map((f) => "<li>" + esc(f.v) + ev({ label: f.label, source: f.source, age: f.age }) + "</li>").join("") + "</ul>" +
      (d.unknown && d.unknown.length ? '<details class="unk"><summary>What I don\'t know</summary><ul>' + d.unknown.map((u) => "<li>" + esc(u) + "</li>").join("") + "</ul></details>" : "") +
      '<p class="follow"><button type="button" class="lnk" data-q="What does the client owe?">Balance</button><button type="button" class="lnk" data-q="What\'s holding it up?">What\'s holding it up</button><button type="button" class="lnk" data-q="Have GRACE prepare an update">Have GRACE prepare an update</button></p>' +
      "</article>";
  },

  RISK_OBJECT: (d, i) => item("RISK_OBJECT", d, i),
  RECEIVABLE_OBJECT: (d, i) => item("RECEIVABLE_OBJECT", d, i),
  COMMITMENT_OBJECT: (d, i) => item("COMMITMENT_OBJECT", d, i),
  WAITING_OBJECT: (d, i) => item("WAITING_OBJECT", d, i),
  LEAD_OBJECT: (d, i) => item("LEAD_OBJECT", d, i),

  DECISION_OBJECT: (d) => {
    const open = d.status === "OPEN";
    const rows = [["What", d.title], ["Why", d.why], ["Requested by", d.requested_by], ["Source", d.source], ["Expected result", d.expected_result],
      ["Risk", RISK[d.risk]], ["Money involved", typeof d.financial_impact === "number" ? money(d.financial_impact) : null], ["Reversibility", d.reversibility],
      ["Deadline", d.deadline], ["If we wait", d.if_we_wait]].filter((x) => x[1]);
    return '<article class="obj decision st-' + esc(d.status) + '" data-decision="' + esc(d.id) + '" aria-label="Decision: ' + esc(d.title) + '">' +
      '<p class="eyebrow">Decision · ' + esc(String(d.type || "").replace(/_/g, " ").toLowerCase()) + " · " + esc(String(d.status || "").toLowerCase()) + "</p>" +
      '<h2 class="dec-t">' + esc(d.title) + "</h2>" +
      '<dl class="dec-g">' + rows.slice(1).map((r) => "<div><dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd></div>").join("") + "</dl>" +
      (d.facts && d.facts.length ? '<div class="dec-l"><b>Verified</b><ul>' + d.facts.map((f) => "<li>" + esc(f) + "</li>").join("") + "</ul></div>" : "") +
      (d.unknowns && d.unknowns.length ? '<div class="dec-l unk"><b>Unknown</b><ul>' + d.unknowns.map((f) => "<li>" + esc(f) + "</li>").join("") + "</ul></div>" : "") +
      (d.draft ? '<div class="draft" data-draft><p class="ev ev-RECOMMENDATION"><span class="evl">Draft</span> · nothing sent</p><div class="draft-b">' + esc(d.draft).replace(/\n/g, "<br>") + "</div></div>" : "") +
      (d.execution ? '<p class="exec">' + esc(d.execution) + "</p>" : "") +
      (open ? '<div class="dec-a"><button type="button" class="act approve" data-res="APPROVE">Approve</button>' + (d.draft ? '<button type="button" class="act" data-edit>Edit</button>' : "") +
        '<button type="button" class="act" data-res="REJECT">Reject</button><button type="button" class="lnk" data-q="Tell me more about ' + esc(d.title) + '">Ask ROYAL</button></div>' : "") +
      "</article>";
  },

  MONEY_FLOW: (d) => '<article class="obj money"><p class="eyebrow">' + esc(d.headline) + "</p>" +
    (typeof d.total === "number" ? '<p class="money-t">' + money(d.total) + "</p>" : "") +
    '<div class="money-p">' + (d.parts || []).map((p) => '<button type="button" class="part"' + (p.entity && p.entity.id ? openQ(p.entity) : " disabled") + '><span class="pa">' + money(p.amount) +
      '</span><span class="pl">' + esc(p.label) + "</span>" + (p.sub ? '<span class="ps">' + esc(p.sub) + "</span>" : "") + "</button>").join("") + "</div>" + ev(d.evidence) + "</article>",

  PRODUCTION_FLOW: (d) => '<article class="obj flow"><p class="eyebrow">Production · ' + esc(d.healthy) + " on track</p>" +
    '<ol class="stages">' + (d.stages || []).map((s) => '<li class="' + (s.attention ? "hot" : "") + '"><span class="sn">' + esc(s.stage) + '</span><span class="sc">' + esc(s.count + s.attention) + "</span>" +
      (s.attention ? '<span class="sa">' + esc(s.attention) + " need" + (s.attention === 1 ? "s" : "") + " attention</span>" : "") + "</li>").join("") + "</ol></article>",

  TIMELINE: (d) => '<article class="obj tl">' + (d.basis ? '<p class="eyebrow">' + esc(d.basis) + "</p>" : "") +
    '<ol>' + (d.events || []).map((e) => '<li class="tone-' + esc(e.tone || "info") + '">' + esc(e.text) + "</li>").join("") + "</ol></article>",

  CLEAR_STATE: (d) => '<article class="obj clear ' + (d.clear ? "yes" : "no") + '"><p class="clear-t">' + (d.clear ? "Clear to step away" : "Before you step away") + "</p>" +
    '<p class="det">Checked: ' + esc((d.checked || []).join(", ")) + ".</p>" + (d.not_checked && d.not_checked.length ? '<p class="det">Not checked: ' + esc(d.not_checked.join(", ")) + ".</p>" : "") + "</article>",

  SYSTEM_HEALTH: (d) => '<article class="obj sys"><p class="eyebrow">Systems</p><ul>' + (d.systems || []).map((s) => '<li class="' + (s.on ? "on" : "off") + '"><i aria-hidden="true"></i><span>' + esc(s.name) + "</span><em>" + esc(s.on ? (s.detail || "Connected") : "Not connected") + "</em></li>").join("") + "</ul></article>",

  MESSAGE_VIEW: (d) => '<article class="obj msg"><p class="eyebrow">Draft' + (d.by ? " by " + esc(d.by) : "") + " · to " + esc(d.to) + " · nothing sent</p>" +
    (d.address || d.subject ? '<dl class="dec-g">' + (d.address ? "<div><dt>Address</dt><dd>" + esc(d.address) + (d.address_status ? ' <span class="hint">' + esc(EMAIL[d.address_status] || d.address_status) + "</span>" : "") + "</dd></div>" : "<div><dt>Address</dt><dd>None yet</dd></div>") +
      (d.subject ? "<div><dt>Subject</dt><dd>" + esc(d.subject) + "</dd></div>" : "") + "</dl>" : "") +
    (d.method === "template" ? '<p class="hint">Written from a template; the language provider is not connected.</p>' : "") +
    '<div class="msg-b">' + esc(d.body).replace(/\n/g, "<br>") + "</div>" + ev({ label: d.label || "RECOMMENDATION", note: d.purpose }) +
    '<p class="follow"><button type="button" class="act approve" data-q="Send it">Send it</button><span class="hint">Sending asks for your approval first.</span></p></article>',

  SEARCH_RESULTS: (d) => '<article class="obj pick"><p class="eyebrow">' + esc(d.prompt) + "</p><ul>" + (d.candidates || []).map((c) =>
    '<li><button type="button" class="choice" data-q="Pull up ' + esc(c.id) + '"><b>' + esc(c.client_name || "") + "</b> " + esc(c.name || "") + ' <span>' + esc(c.stage || "") + "</span></button></li>").join("") + "</ul></article>",

  ACTION_CONFIRMATION: (d) => '<article class="obj confirm"><p class="eyebrow">Handled</p><p class="det">' + esc(d.done) + " done · " + esc(d.pending) + " waiting on you · " + esc(d.refused) + " couldn't be done</p></article>",

  NOT_CONNECTED: (d) => '<article class="obj nc"><p class="eyebrow">Not connected</p><h3 class="obj-t">' + esc(d.what) + "</h3>" + (d.detail ? '<p class="det">' + esc(d.detail) + "</p>" : "") +
    (d.domains ? "<ul>" + d.domains.map((x) => "<li><b>" + esc(x.name) + "</b> " + esc(x.description || "") + "</li>").join("") + "</ul>" : "") + "</article>",

  ERROR_OBJECT: (d) => '<article class="obj err"><p class="eyebrow">Couldn\'t complete</p><dl class="dec-g"><div><dt>Attempted</dt><dd>' + esc(d.attempted) + "</dd></div><div><dt>Why it failed</dt><dd>" + esc(d.failed_because) + "</dd></div>" +
    (d.impact ? "<div><dt>Impact</dt><dd>" + esc(d.impact) + "</dd></div>" : "") + (d.next_action ? "<div><dt>Next</dt><dd>" + esc(d.next_action) + "</dd></div>" : "") + "</dl></article>",

  RESEARCH_OBJECT: (d) => '<article class="obj research"><p class="eyebrow">Research · ' + esc(CONF[d.confidence] || d.confidence) + (d.retrieved ? " · " + esc(d.retrieved) : "") + (d.note ? " · " + esc(d.note) : "") + "</p>" +
    '<p class="stmt-t">' + esc(d.answer) + "</p>" +
    (d.conflicts.length ? '<div class="dec-l unk"><b>Sources disagree</b><ul>' + d.conflicts.map((c) => "<li>" + esc(c) + "</li>").join("") + "</ul></div>" : "") +
    (d.claims.length ? '<ul class="claims">' + d.claims.map(claimLi).join("") + "</ul>" : "") +
    (d.unknowns.length ? '<details class="unk"><summary>What I couldn\'t establish</summary><ul>' + d.unknowns.map((u) => "<li>" + esc(u) + "</li>").join("") + "</ul></details>" : "") +
    sources(d.sources, "All sources") + '<p class="follow"><button type="button" class="lnk" data-q="Where did you get that?">Where did you get that?</button></p></article>',

  PERSON_OBJECT: (d) => '<article class="obj person"><p class="eyebrow">' + esc([d.role, d.company, d.domain].filter(Boolean).join(" · ")) + "</p>" +
    (d.name ? '<h2 class="entity-t">' + esc(d.name) + '</h2><p class="entity-s"><span class="stage">' + esc(d.title || "") + "</span>" + (d.since ? '<span class="due">since ' + esc(d.since) + "</span>" : "") + "</p>" : '<h3 class="obj-t">No one confirmed in the role</h3>') +
    ev({ label: d.label, note: [d.confidence ? CONF[d.confidence] : null, d.confirmed_on ? "confirmed on " + d.confirmed_on : null].filter(Boolean).join(" · ") }) +
    (d.conflict ? '<div class="dec-l unk"><b>Sources disagree</b><p class="det">' + esc(d.conflict) + "</p></div>" : "") +
    (d.email || d.email_status ? '<dl class="dec-g"><div><dt>Business email</dt><dd>' + esc(d.email || "Not found") + (d.email_status ? ' <span class="hint">' + esc(EMAIL[d.email_status] || d.email_status) + "</span>" : "") + "</dd></div></dl>" +
      (d.email_note ? '<p class="hint">' + esc(d.email_note) + "</p>" : "") : "") +
    (d.others.length ? '<details class="unk"><summary>Also found</summary><ul>' + d.others.map((o) => "<li><b>" + esc(o.name) + "</b> " + esc(o.title) + (o.note ? " · " + esc(o.note) : "") + "</li>").join("") + "</ul></details>" : "") +
    sources(d.sources) +
    (d.name ? '<p class="follow">' + (d.email ? "" : '<button type="button" class="lnk" data-q="Find their business email">Business email</button>') + '<button type="button" class="lnk" data-q="Have ACE write an introduction">Have ACE write an introduction</button><button type="button" class="lnk" data-q="Where did you get that?">Sources</button></p>' : "") + "</article>",

  KNOWLEDGE_OBJECT: (d) => '<article class="obj knowledge"><p class="eyebrow">House knowledge</p>' + (d.answer ? '<p class="stmt-t">' + esc(d.answer) + "</p>" + ev({ label: d.label, note: "drawn from the passages below" }) : "") +
    '<ul class="passages">' + d.passages.map((p) => '<li><p class="cite">' + esc(p.citation) + (p.binding === false ? ' <span class="rk rk-ORANGE"><i aria-hidden="true"></i>not decided policy</span>' : p.binding ? ' <span class="rk rk-GREEN"><i aria-hidden="true"></i>active policy</span>' : "") +
      (p.synthetic ? ' <span class="hint">training case</span>' : "") + '</p><p class="det">' + esc(p.text).replace(/\*\*/g, "") + "</p></li>").join("") + "</ul>" +
    (d.unknowns.length ? '<details class="unk"><summary>Not covered</summary><ul>' + d.unknowns.map((u) => "<li>" + esc(u) + "</li>").join("") + "</ul></details>" : "") + "</article>",

  PROSPECT_LIST: (d) => '<article class="obj prospects"><p class="eyebrow">Prospects · ' + esc(d.items.length) + "</p><ol>" + d.items.map((i) => "<li><b>" + esc(i.company) + "</b>" + (i.domain ? ' <span class="hint">' + esc(i.domain) + "</span>" : "") +
    (i.why ? '<p class="det">' + esc(i.why) + "</p>" : "") + (i.person ? '<p class="next"><b>Contact</b> ' + esc(i.person) + (i.title ? ", " + esc(i.title) : "") + "</p>" : "") + ev({ label: i.label }) + sources(i.sources) + "</li>").join("") +
    '</ol><p class="hint">' + esc(d.note) + "</p></article>",

  PLAN_OBJECT: (d) => '<article class="obj plan"><p class="eyebrow">Plan</p><h3 class="obj-t">' + esc(d.goal) + '</h3><ol class="plan-s">' + d.steps.map((x) => '<li class="' + (x.available ? "" : "off") + '">' + esc(x.text) +
    (x.requires === "approval" ? ' <span class="rk rk-ORANGE"><i aria-hidden="true"></i>needs your approval</span>' : "") + (x.available ? "" : ' <span class="hint">not available yet</span>') + "</li>").join("") + "</ol></article>",

  SOURCE_LIST: (d) => '<article class="obj srclist"><p class="eyebrow">Sources</p>' + (d.claims.length ? '<ul class="claims">' + d.claims.map(claimLi).join("") + "</ul>" : "") +
    '<ul class="srcs-open">' + d.sources.map(src).join("") + "</ul></article>",

  TASK_OBJECT: (d) => '<article class="obj task"><p class="eyebrow">Delegated to ' + esc(d.agent) + (d.created ? " · " + esc(d.created) : "") + '</p><p class="det">' + esc(d.objective) + '</p><p class="hint">Status: ' + esc(String(d.status).toLowerCase().replace(/_/g, " ")) + "</p></article>",

  UNKNOWN_OBJECT: (d) => '<article class="obj unkobj"><p class="det">' + esc(d.text) + "</p></article>",
};

export function render(prim, i = 0) {
  const f = R[prim.type];
  return f ? f(prim.data || {}, i) : R.UNKNOWN_OBJECT({ text: "Something I tried to show couldn't be drawn." });
}
