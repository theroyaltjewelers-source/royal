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
const LABEL = { VERIFIED: "Verified", REPORTED_UNVERIFIED: "Reported, not verified", INFERENCE: "Inferred", RECOMMENDATION: "Recommendation", UNKNOWN: "Unknown" };
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
    '<div class="msg-b">' + esc(d.body).replace(/\n/g, "<br>") + "</div>" + ev({ label: d.label || "RECOMMENDATION", note: d.purpose }) +
    '<p class="follow"><button type="button" class="act approve" data-q="Send it">Send it</button><span class="hint">Sending asks for your approval first.</span></p></article>',

  SEARCH_RESULTS: (d) => '<article class="obj pick"><p class="eyebrow">' + esc(d.prompt) + "</p><ul>" + (d.candidates || []).map((c) =>
    '<li><button type="button" class="choice" data-q="Pull up ' + esc(c.id) + '"><b>' + esc(c.client_name || "") + "</b> " + esc(c.name || "") + ' <span>' + esc(c.stage || "") + "</span></button></li>").join("") + "</ul></article>",

  ACTION_CONFIRMATION: (d) => '<article class="obj confirm"><p class="eyebrow">Handled</p><p class="det">' + esc(d.done) + " done · " + esc(d.pending) + " waiting on you · " + esc(d.refused) + " couldn't be done</p></article>",

  NOT_CONNECTED: (d) => '<article class="obj nc"><p class="eyebrow">Not connected</p><h3 class="obj-t">' + esc(d.what) + "</h3>" + (d.detail ? '<p class="det">' + esc(d.detail) + "</p>" : "") +
    (d.domains ? "<ul>" + d.domains.map((x) => "<li><b>" + esc(x.name) + "</b> " + esc(x.description || "") + "</li>").join("") + "</ul>" : "") + "</article>",

  ERROR_OBJECT: (d) => '<article class="obj err"><p class="eyebrow">Couldn\'t complete</p><dl class="dec-g"><div><dt>Attempted</dt><dd>' + esc(d.attempted) + "</dd></div><div><dt>Why it failed</dt><dd>" + esc(d.failed_because) + "</dd></div>" +
    (d.impact ? "<div><dt>Impact</dt><dd>" + esc(d.impact) + "</dd></div>" : "") + (d.next_action ? "<div><dt>Next</dt><dd>" + esc(d.next_action) + "</dd></div>" : "") + "</dl></article>",

  UNKNOWN_OBJECT: (d) => '<article class="obj unkobj"><p class="det">' + esc(d.text) + "</p></article>",
};

export function render(prim, i = 0) {
  const f = R[prim.type];
  return f ? f(prim.data || {}, i) : R.UNKNOWN_OBJECT({ text: "Something ROYAL tried to show could not be drawn." });
}
