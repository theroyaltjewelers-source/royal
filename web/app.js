/* The ROYAL web app.  It talks only to the ROYAL API; it holds no business
   state of its own and draws whatever surface each answer asks for. */

const CFG = window.ROYAL_CONFIG || {};
const $ = (id) => document.getElementById(id) || MISSING(id);
/* A page and script from different versions must never leave a black
   screen: a missing element becomes a harmless stand-in and a visible note. */
function MISSING(id) {
  console.warn("ROYAL: element #" + id + " is missing; web/index.html may be older than web/app.js");
  const el = document.createElement("div"); el.hidden = true; return el;
}
window.addEventListener("error", (e) => {
  const box = document.getElementById("signin") || document.body;
  if (box.hidden) box.hidden = false;
  const p = document.createElement("p"); p.className = "err";
  p.textContent = "ROYAL hit an error while loading (" + (e.message || "unknown") + "). Check that web/index.html, web/app.js and web/styles.css are from the same version.";
  box.appendChild(p);
});
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => (n < 0 ? "-$" : "$") + Math.abs(Math.round(Number(n) || 0)).toLocaleString("en-US");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

let TOKEN = null, REALM = (() => { try { return localStorage.getItem("royal.realm") === "PERSONAL" ? "PERSONAL" : "BUSINESS"; } catch (_) { return "BUSINESS"; } })();
const R = () => "realm=" + REALM;
const CONVO = "web-" + Math.random().toString(36).slice(2, 10);

/* -------------------------------------------------------------- auth --- */
/* ROYAL signs you in with its own passcode, checked by ROYAL's server.  The
   session ROYAL issues is kept on this device so you stay signed in; "Sign
   out" forgets it.  Nothing here involves email or the calculator's login. */
const SESSION_KEY = "royal.session";
function saved() { try { return localStorage.getItem(SESSION_KEY); } catch (_) { return null; } }
function save(t) { try { t ? localStorage.setItem(SESSION_KEY, t) : localStorage.removeItem(SESSION_KEY); } catch (_) {} }

async function boot() {
  /* Arriving from the calculator's ROYAL button: accept its session once,
     then wipe it from the address bar. Optional; the passcode is the main way in. */
  const hand = new URLSearchParams(location.hash.replace(/^#/, ""));
  const handoff = hand.get("access_token") ? hand.get("access_token") : null;
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);

  for (const t of [saved(), handoff, CFG.DEV ? (() => { try { return sessionStorage.getItem("royal.dev"); } catch (_) { return null; } })() : null]) {
    if (!t) continue;
    TOKEN = t;
    const st = await api("GET", "/v1/status");
    if (st.ok) { if (t.startsWith("rs1.")) save(t); return start(st); }
    if (t === saved()) save(null);
  }
  TOKEN = null;
  showSignIn();
}

async function showSignIn(msg) {
  $("signin").hidden = false; $("main").hidden = true;
  $("devBox").hidden = !CFG.DEV;
  if (msg) $("signinStatus").textContent = msg;
  const m = await fetch((CFG.API || "") + "/v1/login-methods").then((r) => r.json()).catch(() => ({}));
  if (m && m.passcode === false && !msg) $("signinStatus").textContent = "ROYAL's passcode is not set up yet. In Render, add ROYAL_OWNER_PASSCODE and ROYAL_SESSION_SECRET, then redeploy.";
  $("passcode").focus();
}
$("passForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter || $("passForm").querySelector("button"); btn.disabled = true;
  $("signinStatus").textContent = "Checking…";
  const r = await fetch((CFG.API || "") + "/v1/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passcode: $("passcode").value }) }).then((x) => x.json()).catch(() => ({ ok: false, message: "ROYAL could not be reached." }));
  btn.disabled = false; $("passcode").value = "";
  if (!r.ok) { $("signinStatus").textContent = r.message || "That did not work."; return; }
  save(r.token); TOKEN = r.token;
  const st = await api("GET", "/v1/status");
  if (!st.ok) return showSignIn(st.message);
  $("signinStatus").textContent = "";
  start(st);
});
$("signOut").addEventListener("click", () => { save(null); TOKEN = null; location.reload(); });
$("devForm").addEventListener("submit", (e) => {
  e.preventDefault(); TOKEN = $("devToken").value.trim();
  try { sessionStorage.setItem("royal.dev", TOKEN); } catch (_) {}
  $("signin").hidden = true; boot();
});

async function api(method, path, body) {
  try {
    const r = await fetch((CFG.API || "") + path, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
      body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({ ok: false, message: "ROYAL replied with something unreadable." }));
    if (!r.ok && j.ok === undefined) j.ok = false;
    return j;
  } catch (e) {
    return { ok: false, error: "NETWORK", message: "ROYAL could not be reached. Nothing was done." };
  }
}

/* ------------------------------------------------------------- start --- */
const SUGGEST = { BUSINESS: ["What needs me?", "State of the House", "Can I step away?", "Who owes us money?", "What are we waiting on?", "What changed today?", "Which promises are due?"],
  PERSONAL: ["What's on my calendar tomorrow?", "My wealth", "My personal tasks"] };

function start(st) {
  $("signin").hidden = true; $("main").hidden = false; $("signOut").hidden = false;
  window.__prov = st.provider || {};
  applyRealm();
  renderConn(st);
  renderChips();
  loadHome(); loadDecisionCount();
}

function renderConn(st) {
  const c = st.calculator || {}, p = st.provider || {};
  const chip = (label, ok, detail) => '<span class="cchip ' + (ok ? "on" : "off") + '"><span class="dot" aria-hidden="true"></span>' + esc(label) + ": " + esc(detail) + "</span>";
  if (REALM === "PERSONAL") { $("conn").innerHTML = '<span class="cchip realmtag">PERSONAL · separate from the business</span>'; return; }
  $("conn").innerHTML = chip("Calculator", c.connected, c.connected ? c.age : "not connected") + chip("Language", p.status === "CONNECTED", p.status === "CONNECTED" ? "connected" : "not connected");
}

function renderChips() {
  $("chips").innerHTML = SUGGEST[REALM].map((q) => '<button type="button" class="chip" data-q="' + esc(q) + '">' + esc(q) + "</button>").join("");
}
$("chips").addEventListener("click", (e) => { const b = e.target.closest("[data-q]"); if (b) ask(b.dataset.q); });

/* Business and Personal are two separate rooms: their own colour, home,
   suggestions, conversation, decisions and activity.  Switching clears
   whatever was on screen, so nothing from one side is ever left showing on
   the other.  The server enforces the same wall. */
function applyRealm() {
  document.body.classList.toggle("realm-personal", REALM === "PERSONAL");
  const house = document.querySelector(".mark .house"); if (house) house.textContent = REALM === "PERSONAL" ? "TAHIR · PERSONAL" : "THE HOUSE OF ROYAL T";
  document.querySelectorAll(".realms button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.realm === REALM)));
  document.querySelectorAll('.views [data-view="agents"]').forEach((x) => { x.hidden = REALM === "PERSONAL"; });
  $("ask").placeholder = REALM === "PERSONAL" ? "Ask about your personal side…" : "Ask ROYAL anything…";
  $("answer").hidden = true; $("answer").innerHTML = "";
  document.querySelectorAll(".view").forEach((v) => { v.innerHTML = ""; });
}
function switchRealm(to) {
  REALM = to; try { localStorage.setItem("royal.realm", to); } catch (_) {}
  applyRealm(); renderChips(); renderConn({ calculator: {}, provider: window.__prov || {} });
  showView("home"); loadDecisionCount();
}
document.querySelectorAll(".realms button").forEach((b) => b.addEventListener("click", () => switchRealm(b.dataset.realm)));

/* ----------------------------------------------------------- command --- */
$("command").addEventListener("submit", (e) => { e.preventDefault(); const q = $("ask").value.trim(); if (q) { ask(q); $("ask").value = ""; } });

const STEPS = ["Understanding request", "Checking the records", "Consulting the specialists", "Synthesising"];
async function ask(q, extra = {}) {
  const w = $("working"); w.hidden = false;
  let i = 0; w.innerHTML = '<span class="pulse" aria-hidden="true"></span>' + STEPS[0];
  const t = setInterval(() => { i = Math.min(i + 1, STEPS.length - 1); w.lastChild.textContent = STEPS[i]; }, reduceMotion ? 1500 : 450);
  const r = await api("POST", "/v1/command", { content: q, conversation_id: CONVO, realm: REALM, ...extra });
  clearInterval(t); w.hidden = true;
  const a = $("answer"); a.hidden = false;
  if (!r.ok) { a.innerHTML = '<div class="err"><b>That did not go through.</b> ' + esc(r.message || r.error) + "</div>"; return; }
  a.innerHTML = renderResult(r.result, q);
  if (!reduceMotion) a.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: "ease-out" });
  a.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
  if (r.result.connection) renderConn({ calculator: r.result.connection, provider: (window.__prov || {}) });
  if (["handle_it", "decisions_open"].indexOf(r.result.skill) >= 0) { loadDecisionCount(); }
}

function renderResult(r, q) {
  const s = r.surface || { type: "text" };
  const head = '<div class="ahead"><p class="q">' + esc(q) + '</p><p class="summary">' + esc(r.summary) + "</p>" + deleg(r) + "</div>";
  return head + (SURFACES[s.type] || SURFACES.text)(s, r);
}

function deleg(r) {
  const d = (r.delegations || []).filter((x, i, a) => a.findIndex((y) => y.agent === x.agent) === i);
  if (!d.length) return "";
  return '<p class="deleg">' + d.map((x) => '<span class="' + (x.verified ? "ok" : "bad") + '">' + esc(x.agent.toUpperCase()) + (x.verified ? "" : " did not report") + "</span>").join("") + "</p>";
}

/* ---------------------------------------------------------- surfaces --- */
const RISK_TEXT = { GREEN: "Healthy", YELLOW: "Watch", ORANGE: "At risk", RED: "Serious", BLACK: "Critical" };
const NEED_TEXT = { KNOW: "For your information", DECIDE: "Needs your decision", APPROVE: "Needs your approval", DO: "Needs action", DELEGATE: "Can be delegated", MONITOR: "Monitoring", NONE: "" };
const LABEL = { VERIFIED: "Verified", REPORTED_UNVERIFIED: "Reported, unverified", INFERENCE: "Inferred", RECOMMENDATION: "Recommendation", UNKNOWN: "Unknown" };

function evidence(e) {
  if (!e) return "";
  return '<span class="ev ev-' + esc(e.label) + '">' + esc(LABEL[e.label] || e.label) + (e.label === "VERIFIED" && e.source ? " · " + esc(e.source) : "") + (e.age ? " · " + esc(e.age) : "") + (e.note ? " · " + esc(e.note) : "") + "</span>";
}

function item(i, big) {
  const ent = i.entity && i.entity.id ? '<span class="ent">' + esc(i.entity.client_name || "") + (i.entity.name ? " · " + esc(i.entity.name) : "") + "</span>" : "";
  return '<li class="it pr-' + esc(i.priority) + " rk-" + esc(i.risk) + (big ? " lead" : "") + '">' +
    '<div class="it-top"><span class="pri">' + esc(i.priority) + '</span><span class="risk"><span class="rdot" aria-hidden="true"></span>' + esc(RISK_TEXT[i.risk] || i.risk) + "</span>" +
    (i.need && NEED_TEXT[i.need] ? '<span class="need">' + esc(NEED_TEXT[i.need]) + "</span>" : "") + (i.amount ? '<span class="amt">' + money(i.amount) + "</span>" : "") + "</div>" +
    '<p class="it-title">' + esc(i.title) + "</p>" + ent +
    (i.detail ? '<p class="it-detail">' + esc(i.detail) + "</p>" : "") +
    (i.next_action ? '<p class="it-next"><span>Next</span> ' + esc(i.next_action) + (i.owner ? ' <span class="own">Owner: ' + esc(i.owner) + "</span>" : "") + "</p>" : "") +
    '<p class="it-foot">' + evidence(i.evidence) + (i.entity && i.entity.id ? '<button type="button" class="link" data-q="status of ' + esc(i.entity.id) + '">Open</button>' : "") + "</p></li>";
}
const list = (items, empty, more, askq) => items && items.length ? '<ul class="items">' + items.map((x, n) => item(x, n === 0 && x.priority === "P1")).join("") + "</ul>" +
  (more ? '<p class="more"><button type="button" class="link" data-q="' + esc(askq || "What needs me?") + '">' + more + " more</button></p>" : "") : '<p class="empty">' + esc(empty || "Nothing here.") + "</p>";

const SURFACES = {
  text: (s) => (s.label ? '<p class="evline">' + evidence({ label: s.label }) + "</p>" : "") +
    (s.based_on && s.based_on.length ? '<details class="basis"><summary>Based on</summary><ul>' + s.based_on.map((f) => "<li>" + esc(f.text) + "</li>").join("") + "</ul></details>" : "") +
    (s.unknowns && s.unknowns.length ? '<p class="unk"><b>Unknown:</b> ' + s.unknowns.map(esc).join("; ") + "</p>" : "") +
    (s.proposals && s.proposals.length ? '<ul class="props">' + s.proposals.map((p) => "<li>" + esc(p.tool.replace(/_/g, " ")) + ": " + esc(p.status === "PENDING_APPROVAL" ? "sent to your Decisions" : p.status === "DENIED" ? "refused (" + p.reason + ")" : p.status) + "</li>").join("") + "</ul>" : ""),
  suggest: (s) => '<div class="chips inline">' + s.suggestions.map((q) => '<button type="button" class="chip" data-q="' + esc(q) + '">' + esc(q) + "</button>").join("") + "</div>",
  attention: (s) => list(s.items, s.empty),
  step_away: (s) => s.clear
    ? '<div class="clear"><p class="big">CLEAR TO STEP AWAY</p><p class="quiet">Checked: ' + s.checked.map(esc).join(", ") + ". Not checked: " + s.not_checked.map(esc).join(", ") + ".</p></div>"
    : '<div class="before"><p class="kicker">Before you step away</p><ol class="items">' + s.before.map((x) => item(x)).join("") + "</ol><p class=\"quiet\">Not checked: " + s.not_checked.map(esc).join(", ") + ".</p></div>",
  state: (s) => '<div class="state rk-' + esc(s.risk) + '"><p class="headline">' + esc(s.headline) + '</p><dl class="lines">' + s.lines.map((l) => "<div><dt>" + esc(l.k) + "</dt><dd>" + esc(l.v) + "</dd></div>").join("") + "</dl></div>" + (s.top.length ? "<h3>Top priorities</h3>" + list(s.top) : ""),
  briefing: (s) => s.sections.map((sec) => '<section class="bsec" id="b-' + esc(sec.id) + '"><h3>' + esc(sec.title) + "</h3>" + (sec.text ? '<p class="btext">' + esc(sec.text) + "</p>" : "") +
    (sec.lines ? '<dl class="lines">' + sec.lines.map((l) => "<div><dt>" + esc(l.k) + "</dt><dd>" + esc(l.v) + "</dd></div>").join("") + "</dl>" : "") + (sec.items ? list(sec.items, null, sec.more, sec.ask) : "") + "</section>").join(""),
  money: (s) => '<div class="figs"><div><small>Outstanding</small><b>' + money(s.receivable) + '</b></div><div><small>Collected on live work</small><b>' + money(s.collected) + '</b></div><div><small>Production not yet funded</small><b>' + money(s.unfunded) + "</b></div>" +
    (s.treasury && s.treasury.runway_days != null ? "<div><small>Runway</small><b>" + esc(s.treasury.runway_days) + " days</b></div>" : "") + "</div>" + list(s.items, "Nobody owes the House anything."),
  waiting: (s) => list(s.items, "Nothing is waiting."),
  commitments: (s) => list(s.items, "NO COMMITMENTS OVERDUE."),
  production: (s) => "<h3>Exceptions</h3>" + list(s.exceptions, "No production exceptions.") + (s.healthy.length ? '<details class="healthy"><summary>' + s.healthy.length + " on track</summary><ul>" + s.healthy.map((p) => '<li><button type="button" class="link" data-q="status of ' + esc(p.id) + '">' + esc(p.client_name + " · " + p.name) + "</button> <span class=\"quiet\">" + esc(p.stage) + "</span></li>").join("") + "</ul></details>" : ""),
  changes: (s) => s.changes.length ? '<ol class="timeline">' + s.changes.map((c) => '<li class="tone-' + esc(c.tone) + '">' + esc(c.text) + "</li>").join("") + '</ol><p class="quiet">' + esc(s.basis || "") + '. <button type="button" class="link" data-q="What changed? Mark as seen">Mark as seen</button></p>' : '<p class="empty">Nothing has changed.</p>',
  decisions: (s) => s.decisions.length ? s.decisions.map(decisionCard).join("") : '<p class="empty">' + esc(s.empty) + "</p>",
  pipeline: (s) => list(s.items, "No stalled leads.") + (s.leads.length ? '<details class="healthy"><summary>' + s.leads.length + " open leads</summary><ul>" + s.leads.map((l) => "<li>" + esc(l.client_name + " · " + l.name + " · " + l.stage) + "</li>").join("") + "</ul></details>" : ""),
  systems: (s) => '<dl class="lines"><div><dt>Calculator</dt><dd>' + esc(s.calculator.connected ? "Connected, " + s.calculator.age + " (" + s.calculator.freshness.toLowerCase() + ")" : "NOT CONNECTED") + "</dd></div><div><dt>Language provider</dt><dd>" + esc(s.provider.status === "CONNECTED" ? "Connected (" + (s.provider.model || "") + ")" : "NOT CONNECTED. " + (s.provider.detail || "")) + "</dd></div>" +
    s.domains.map((d) => "<div><dt>" + esc(d.name) + ' <span class="quiet">' + esc(d.realm.toLowerCase()) + "</span></dt><dd>" + esc(d.status === "CONNECTED" ? "Connected" : "NOT CONNECTED") + "</dd></div>").join("") + "</dl>" + list(s.items, "No system issues."),
  project: (s) => { const a = s.answer; const p = s.project;
    return '<div class="proj"><p class="kicker">' + esc(p.id) + " · " + esc(p.client && p.client.name) + '</p><h3 class="ptitle">' + esc(p.name) + "</h3>" +
      '<dl class="answer-grid">' + [["Current state", a.current_state], ["Why", a.why], ["Owner", a.owner], ["Next action", a.next_action], ["Deadline", a.deadline], ["Risk", RISK_TEXT[a.risk]], ["Tahir required", NEED_TEXT[a.tahir_required] || "No"]]
        .filter((x) => x[1]).map((x) => "<div><dt>" + esc(x[0]) + "</dt><dd>" + esc(x[1]) + "</dd></div>").join("") + "</dl>" +
      "<h4>Verified</h4><ul class=\"facts\">" + a.verified.map((v) => "<li>" + esc(v.text) + " " + evidence(v) + "</li>").join("") + "</ul>" +
      "<h4>Unknown</h4><ul class=\"facts unknown\">" + a.unknown.map((u) => "<li>" + esc(u) + "</li>").join("") + "</ul>" +
      (s.items.length ? "<h4>Open items</h4>" + list(s.items) : "") + (s.decisions.length ? "<h4>Decisions</h4>" + s.decisions.map(decisionCard).join("") : "") + "</div>"; },
  clarify: (s) => '<ul class="pick">' + s.candidates.map((c) => '<li><button type="button" class="chip" data-q="status of ' + esc(c.id) + '">' + esc((c.client_name || "") + " · " + (c.name || "") + " · " + c.stage) + "</button></li>").join("") + "</ul>",
  personal_home: (s) => '<div class="nc"><p class="kicker">Your personal side</p><dl class="lines">' + s.domains.map((d) => "<div><dt>" + esc(d.name) + "</dt><dd>" + esc(d.status === "CONNECTED" ? "Connected" : "Not connected yet") + "</dd></div>").join("") +
    '</dl><p class="quiet">Nothing from the business appears here, and nothing personal appears on the Business side.</p></div>',
  realm_switch: (s) => '<p><button type="button" class="primary" data-realm-go="' + esc(s.to) + '">Go to ' + (s.to === "PERSONAL" ? "Personal" : "Business") + "</button></p>",
  not_connected: (s) => '<div class="nc"><p class="big">NOT CONNECTED</p>' + (s.domains ? "<ul>" + s.domains.map((d) => "<li><b>" + esc(d.name) + "</b> " + esc(d.description || "") + "</li>").join("") + "</ul>" : "") + (s.detail ? '<p class="quiet">' + esc(s.detail) + "</p>" : "") + "</div>",
  handled: (s) => '<dl class="lines"><div><dt>Done</dt><dd>' + s.done.length + "</dd></div><div><dt>Waiting on your approval</dt><dd>" + s.pending.length + "</dd></div><div><dt>Could not act</dt><dd>" + s.refused.length + "</dd></div></dl>" +
    (s.pending.length ? '<button type="button" class="primary" data-view-go="decisions">Review decisions</button>' : "") + '<p class="quiet">' + esc(s.verification) + "</p>",
};

/* --------------------------------------------------------- decisions --- */
const REV = { REVERSIBLE: "Reversible", PARTIALLY_REVERSIBLE: "Partly reversible", DIFFICULT_TO_REVERSE: "Hard to reverse", IRREVERSIBLE: "Cannot be undone" };
function decisionCard(d) {
  const open = d.status === "OPEN";
  const draft = d.action && d.action.args && d.action.args.draft;
  return '<article class="dcard rk-' + esc(d.risk) + '" data-id="' + esc(d.id) + '"><header><span class="pri">' + esc(d.priority) + '</span><span class="dtype">' + esc(d.type.replace(/_/g, " ").toLowerCase()) + "</span>" +
    '<span class="dstatus">' + esc(d.status.toLowerCase()) + "</span></header><h3>" + esc(d.title) + "</h3>" +
    '<dl class="dgrid">' + [["What", d.action ? d.action.tool.replace(/_/g, " ") : d.type.replace(/_/g, " ").toLowerCase()], ["Why", d.reasoning_summary], ["Requested by", String(d.requested_by_agent).toUpperCase()],
      ["Source", d.source], ["Expected result", d.expected_result], ["Material risk", RISK_TEXT[d.risk]], ["Financial effect", d.financial_impact != null ? money(d.financial_impact) : null], ["Reversibility", REV[d.reversibility]]]
      .filter((x) => x[1]).map((x) => "<div><dt>" + esc(x[0]) + "</dt><dd>" + esc(x[1]) + "</dd></div>").join("") + "</dl>" +
    (draft ? '<blockquote class="draft">' + esc(draft.body).replace(/\n/g, "<br>") + '<footer><span class="ev ev-RECOMMENDATION">Draft · nothing sent</span></footer></blockquote>' : (d.description ? '<p class="it-detail">' + esc(d.description) + "</p>" : "")) +
    (d.unknowns && d.unknowns.length ? '<p class="unk"><b>Unknown:</b> ' + d.unknowns.map(esc).join("; ") + "</p>" : "") +
    (d.execution ? '<p class="exec">' + esc(d.execution.result === "NO_EXECUTOR" ? "Approved. " + d.execution.next_action : d.execution.result + (d.execution.failed_because ? ": " + d.execution.failed_because : "")) + "</p>" : "") +
    (open ? '<div class="dact"><button type="button" class="primary" data-res="APPROVE">Approve</button><button type="button" data-res="MODIFY"' + (draft ? "" : " disabled") + '>Modify</button><button type="button" data-res="REJECT">Reject</button><button type="button" class="link" data-q="Tell me about ' + esc(d.related_project_id || d.title) + '">Ask ROYAL</button></div>' : "") +
    "</article>";
}

document.addEventListener("click", async (e) => {
  const q = e.target.closest("[data-q]"); if (q && !q.closest("#chips")) { ask(q.dataset.q); return; }
  const go = e.target.closest("[data-view-go]"); if (go) { showView(go.dataset.viewGo); return; }
  const rg = e.target.closest("[data-realm-go]"); if (rg) { switchRealm(rg.dataset.realmGo); return; }
  const b = e.target.closest("[data-res]"); if (!b) return;
  const card = b.closest(".dcard"), id = card.dataset.id, res = b.dataset.res;
  let body = { resolution: res };
  if (res === "MODIFY") {
    const d = (window.__decisions || []).find((x) => x.id === id);
    $("modifyBody").value = d && d.action && d.action.args.draft ? d.action.args.draft.body : "";
    const ok = await new Promise((done) => { $("modify").onclose = () => done($("modify").returnValue === "ok"); $("modify").showModal(); });
    if (!ok) return;
    body = { resolution: "MODIFY", modified_args: { draft: { ...(d.action.args.draft || {}), body: $("modifyBody").value } }, note: $("modifyNote").value };
  }
  card.querySelectorAll("button").forEach((x) => { x.disabled = true; });
  const r = await api("POST", "/v1/decisions/" + encodeURIComponent(id) + "/resolve", body);
  if (r.decision) card.outerHTML = decisionCard(r.decision);
  else card.insertAdjacentHTML("beforeend", '<p class="err">' + esc(r.failed_because || r.message || "Not resolved.") + "</p>");
  loadDecisionCount();
});

/* ------------------------------------------------------------- views --- */
document.querySelectorAll(".views button").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
function showView(v) {
  document.querySelectorAll(".views button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.view === v)));
  document.querySelectorAll(".view").forEach((x) => { x.hidden = x.id !== "view-" + v; });
  ({ home: loadHome, decisions: loadDecisions, activity: loadActivity, agents: loadAgents, systems: loadSystems })[v]();
}

async function loadHome() {
  const r = await api("POST", "/v1/command", { skill: REALM === "PERSONAL" ? "personal" : "morning_briefing", content: "Home", realm: REALM, conversation_id: CONVO + "-home", modality: "ui_action" });
  const el = $("view-home");
  if (!r.ok) { el.innerHTML = '<p class="err">' + esc(r.message) + "</p>"; return; }
  el.innerHTML = '<p class="summary home">' + esc(r.result.summary) + "</p>" + SURFACES[r.result.surface.type](r.result.surface, r.result);
  if (r.result.connection) renderConn({ calculator: r.result.connection, provider: window.__prov || {} });
}
async function loadDecisionCount() {
  const r = await api("GET", "/v1/decisions?status=OPEN&" + R());
  const n = r.ok ? r.decisions.length : 0;
  $("decCount").textContent = n ? String(n) : ""; $("decCount").hidden = !n;
}
async function loadDecisions() {
  const r = await api("GET", "/v1/decisions?" + R());
  window.__decisions = r.decisions || [];
  const open = window.__decisions.filter((d) => d.status === "OPEN"), done = window.__decisions.filter((d) => d.status !== "OPEN");
  $("view-decisions").innerHTML = (open.length ? open.map(decisionCard).join("") : '<p class="empty">NO DECISIONS NEED YOU.</p>') +
    (done.length ? '<details class="healthy"><summary>' + done.length + " resolved</summary>" + done.map(decisionCard).join("") + "</details>" : "");
}
async function loadActivity() {
  const r = await api("GET", "/v1/activity?" + R());
  const a = r.activity || [];
  $("view-activity").innerHTML = a.length ? '<ol class="ledger">' + a.map((x) => "<li><time>" + esc(new Date(x.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })) + "</time><span>" + esc(x.summary || x.action) + "</span></li>").join("") + "</ol>" : '<p class="empty">No activity recorded yet.</p>';
}
async function loadAgents() {
  const [ag, sys] = await Promise.all([api("GET", "/v1/agents"), api("POST", "/v1/command", { skill: "what_needs_me", content: "agents", conversation_id: CONVO + "-agents", modality: "ui_action" })]);
  const byAgent = {}; ((sys.result && sys.result.findings) || []).forEach((f) => { (byAgent[f.agent] = byAgent[f.agent] || []).push(f); });
  $("view-agents").innerHTML = '<p class="quiet">You talk to ROYAL. These are the specialists it consults.</p><div class="agents">' + (ag.agents || []).map((a) => '<article class="agent"><header><h3>' + esc(a.name) + '</h3><span class="quiet">v' + esc(a.version) + "</span></header><p class=\"role\">" + esc(a.role) + "</p><p class=\"it-detail\">" + esc(a.description) + "</p>" +
    "<dl class=\"lines\"><div><dt>Status</dt><dd>" + esc(a.status.toLowerCase()) + "</dd></div><div><dt>Realms</dt><dd>" + esc(a.realms.join(", ").toLowerCase()) + "</dd></div><div><dt>Open items</dt><dd>" + ((byAgent[a.id] || []).length) + "</dd></div><div><dt>Permissions</dt><dd>" + esc(a.permission_profile) + "</dd></div></dl></article>").join("") + "</div>";
}
async function loadSystems() {
  if (REALM === "PERSONAL") {
    const d = await api("GET", "/v1/domains?" + R());
    $("view-systems").innerHTML = '<dl class="lines">' + (d.domains || []).map((x) => "<div><dt>" + esc(x.name) + "</dt><dd>" + esc(x.status === "CONNECTED" ? "Connected" : "NOT CONNECTED") + "</dd></div>").join("") + "</dl>";
    return;
  }
  const r = await api("POST", "/v1/command", { skill: "system_status", content: "systems", conversation_id: CONVO + "-sys", modality: "ui_action" });
  $("view-systems").innerHTML = r.ok ? SURFACES.systems(r.result.surface) : '<p class="err">' + esc(r.message) + "</p>";
  if (r.ok) window.__prov = r.result.surface.provider;
}

boot();
