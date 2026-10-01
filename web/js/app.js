/* ROYAL: the interaction layer.

   One presence, one conversation.  Tahir touches the Core (or speaks, or
   types) and ROYAL answers with words and, when useful, with objects placed
   around it.  This file wires the pieces together:

     RoyalState  what ROYAL is doing, with legal transitions only
     RoyalCore   how that looks (web/js/core.js)
     Stage       where answers appear (web/js/stage.js)
     Voice       speech in and out, with barge-in (web/js/voice.js)
     Sound       quiet cues and haptics (web/js/sound.js)

   The page holds no business state.  Everything shown comes from the ROYAL
   API, which composes and validates the presentation on the server. */

import { RoyalCore } from "./core.js";
import { RoyalState, STATES, LABELS } from "./state.js";
import { Stage } from "./stage.js";
import { Voice } from "./voice.js";
import { Sound } from "./sound.js";
import { validateSpec } from "./schema.js";
import { esc } from "./primitives.js";
import { BotsPanel } from "./bots.js";
import { RealtimeVoice } from "./realtime.js";
import { providerNotice, providerProblem, serverProblem } from "./notices.js";

const CFG = window.ROYAL_CONFIG || {};
const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise((r) => setTimeout(r, reduced ? Math.min(ms, 60) : ms));
const store = { get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) {} } };

/* ----------------------------------------------------------- pieces --- */
const core = new RoyalCore($("core"), { reducedMotion: reduced });
const state = new RoyalState("OFFLINE");
const sound = new Sound();
const stage = new Stage({ core, column: $("column"), objects: $("objects"), caption: $("caption"), heard: $("heard"), agents: $("agents"), reduced });
core.set(STATES.OFFLINE);
core.onFallback = (mode) => { document.body.dataset.render = mode; };
document.body.dataset.render = core.mode;

stage.onLayout = (b) => {
  const w = $("wake"); w.style.left = (b.x - b.r * 1.15) + "px"; w.style.top = (b.y - b.r * 1.15) + "px"; w.style.width = w.style.height = (b.r * 2.3) + "px";
  const h = $("hud").style; h.setProperty("--x", b.x + "px"); h.setProperty("--y", b.y + "px"); h.setProperty("--d", (b.r * 3.0) + "px");
};
/* The HUD rings and the status bars move with the Core's own level (voice,
   speech, press), once per drawn frame, and only when it changes. */
let hudLvl = -1;
core.onLevel = (a) => {
  const v = reduced ? 0 : Math.min(1, a * 1.6);
  if (Math.abs(v - hudLvl) < 0.01) return;
  hudLvl = v; const s = v.toFixed(3); $("hud").style.setProperty("--lvl", s); $("modeInd").style.setProperty("--lvl", s);
};
stage.layout();

state.on((next) => {
  core.set(STATES[next]);
  document.body.dataset.state = next;
  $("stateLbl").textContent = LABELS[next];
  $("live-state").textContent = "ROYAL: " + LABELS[next];
});

const voice = new Voice({
  onPartial: (t) => { stage.setHeard(t); bump(); },
  onFinal: (t) => submit(t, "voice"),
  onState: (s) => { if (s === "listening") { state.go("LISTENING"); sound.play("listen"); } else if (state.state === "LISTENING") { state.go("AWAKE"); settle(); } },
  onLevel: (a) => core.setAmplitude(a),
  onError: (code, msg) => { if (msg) { stage.setCaption(msg, { quiet: true }); openType(); } },
  onSpeechBoundary: () => core.pulse(0.55),
  onSpeaking: (on) => { core.setSpeaking(on); document.body.dataset.speaking = on ? "1" : "0"; },
  audio: () => sound.ac,   /* the context the first touch unlocked, so iPhone plays ROYAL's voice */
});

/* --------------------------------------------------------- session --- */
let TOKEN = null, STATUS = null, SAID_CALC = false;
let REALM = store.get("royal.realm") === "PERSONAL" ? "PERSONAL" : "BUSINESS";
let CONVO = newConvo();
function newConvo() { return "web-" + REALM.toLowerCase().slice(0, 3) + "-" + Math.random().toString(36).slice(2, 10); }

async function api(method, path, body) {
  try {
    const r = await fetch((CFG.API || "") + path, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({ ok: false, message: serverProblem({ status: r.status }) }));
    if (r.status === 401) { j.ok = false; j.unauthorized = true; }
    if (!r.ok && j.ok === undefined) j.ok = false;
    return j;
  } catch (_) { return { ok: false, network: true, message: serverProblem({ network: true }) }; }
}

async function start() {
  /* A session handed over from the calculator's ROYAL button arrives in the
     address fragment; accept it once and wipe it from the address bar. */
  const hand = new URLSearchParams(location.hash.replace(/^#/, ""));
  const handoff = hand.get("access_token");
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  for (const t of [store.get("royal.session"), handoff]) {
    if (!t) continue;
    TOKEN = t;
    const st = await api("GET", "/v1/status");
    if (st.ok) { if (t.startsWith("rs1.")) store.set("royal.session", t); return enter(st); }
    if (st.network) return offline();
    if (t === store.get("royal.session")) store.set("royal.session", null);
  }
  TOKEN = null; showSignIn();
}

async function showSignIn(msg) {
  $("signin").hidden = false; document.body.dataset.auth = "out";
  $("signinStatus").textContent = msg || "";
  const m = await fetch((CFG.API || "") + "/v1/login-methods").then((r) => r.json()).catch(() => null);
  if (!m) $("signinStatus").textContent = serverProblem({ network: true }).replace(" Nothing was done.", " Then try again.");
  else if (m.passcode === false && !msg) $("signinStatus").textContent = "ROYAL's passcode is not set up yet. In Render, add ROYAL_OWNER_PASSCODE and ROYAL_SESSION_SECRET, then redeploy.";
  $("passcode").focus();
}
$("passForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("passForm").querySelector("button"); btn.disabled = true;
  $("signinStatus").textContent = "Checking…";
  const r = await fetch((CFG.API || "") + "/v1/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passcode: $("passcode").value }) })
    .then((x) => x.json().catch(() => ({ ok: false, message: serverProblem({ status: x.status }) }))).catch(() => ({ ok: false, message: serverProblem({ network: true }) }));
  btn.disabled = false; $("passcode").value = "";
  if (!r.ok) { $("signinStatus").textContent = r.message || "That did not work."; return; }
  store.set("royal.session", r.token); TOKEN = r.token;
  const st = await api("GET", "/v1/status");
  if (!st.ok) return showSignIn(st.message);
  $("signin").hidden = true; $("signinStatus").textContent = "";
  enter(st, { firstSignIn: true });
});

async function enter(st, { firstSignIn = false } = {}) {
  STATUS = st; $("signin").hidden = true; document.body.dataset.auth = "in";
  applyRealm();
  if (firstSignIn || !store.get("royal.booted")) await runBoot();
  state.go("AMBIENT", "signed in");
  stage.setCaption(REALM === "PERSONAL" ? "Personal. Touch to talk." : "Touch to talk.", { quiet: true });
  $("wake").focus({ preventScroll: true });
  refreshDecisionMark();
  loadIntelligence();
  checkBrain(st.provider);
}

/* ---------------------------------------------------------- notices --- */
/* A standing, dismissible notice when the AI provider is down, in plain
   words with the fix.  Dismissed once, it stays away until the cause changes. */
let noticeKind = null, noticeDismissed = null;
function checkBrain(provider) {
  const n = providerNotice(provider), p = providerProblem(provider);
  if (!n) { noticeKind = null; $("notice").hidden = true; document.body.dataset.notice = "0"; return; }
  if (noticeDismissed === p.kind) return;
  noticeKind = p.kind;
  $("noticeT").textContent = n.title; $("noticeX").textContent = n.text; $("notice").dataset.tone = n.tone; $("notice").hidden = false; document.body.dataset.notice = "1";
}
$("noticeClose").addEventListener("click", () => { noticeDismissed = noticeKind; $("notice").hidden = true; document.body.dataset.notice = "0"; });
async function refreshBrain() { const st = await api("GET", "/v1/status"); if (st.ok) checkBrain(st.provider); }

/* What the intelligence layer can do on this server right now. */
let INTEL = null, rt = null;
async function loadIntelligence() {
  const r = await api("GET", "/v1/intelligence/status");
  INTEL = r.ok ? r : null;
  /* ROYAL's one voice, from the server, on every device (Business only). */
  voice.useServer(INTEL && INTEL.spoken_voice === "AVAILABLE" ? { ready: () => REALM === "BUSINESS", fetch: speechFor } : null);
  if (INTEL && INTEL.realtime_voice === "AVAILABLE" && !rt) {
    rt = new RealtimeVoice({ api, ask: askFromVoice, realm: () => REALM,
      onState: (s) => {
        document.body.dataset.rt = s;
        if (s === "live" || s === "listening") { if (state.state !== "LISTENING" && !busy) state.go("LISTENING"); }
        else if (s === "speaking") { if (state.state !== "RESPONDING") state.go("RESPONDING"); }
        else if (s === "disconnected") { stage.setCaption("The voice connection closed. Your conversation is kept; touch to reconnect, or type.", { quiet: true }); state.go("AWAKE"); settle(); }
      },
      onHeard: (t, final) => { stage.setHeard(t); bump(); },
      onSaid: (t) => stage.setCaption(t),
      onLevel: (a) => { core.setAmplitude(a); core.pulse(a * 0.6); },
      onError: (m) => { stage.setCaption(m, { quiet: true }); } });
  }
}
async function speechFor(text, signal) {
  const r = await fetch((CFG.API || "") + "/v1/voice/speak?realm=" + REALM, { method: "POST", signal,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN }, body: JSON.stringify({ text: text.slice(0, 1200) }) });
  return r.ok ? r.arrayBuffer() : null;
}
async function askFromVoice(text) {
  for (let i = 0; i < 40 && busy; i++) await wait(250);
  return submit(text, "voice", { speak: false });
}

function offline() {
  state.go("OFFLINE"); stage.clear();
  stage.setCaption("I can't reach my server right now. Nothing was done.", { quiet: true });
  $("retry").hidden = false;
}
$("retry").addEventListener("click", () => { $("retry").hidden = true; start(); });

/* ------------------------------------------------------------ boot --- */
/* The boot sequence shows only what the server reports is true.  First
   launch on a device, or replayed from Systems.  A tap skips it. */
async function runBoot() {
  const box = $("boot"), list = $("bootLines");
  const r = await api("GET", "/v1/boot");
  if (!r.ok) return;
  box.hidden = false; list.innerHTML = ""; let skip = false;
  const onSkip = () => { skip = true; }; box.addEventListener("click", onSkip, { once: true });
  core.set({ ...STATES.OFFLINE, energy: 0.3 });
  for (const [i, l] of r.lines.entries()) {
    if (skip) break;
    list.insertAdjacentHTML("beforeend", '<li class="' + (l.ok ? "ok" : "no") + '"><span class="k">' + esc(l.k) + '</span><span class="v">' + esc(l.v) + "</span>" + (l.detail ? '<span class="d">' + esc(l.detail) + "</span>" : "") + "</li>");
    core.set({ ...STATES.AMBIENT, energy: 0.3 + 0.6 * (i + 1) / r.lines.length, scale: 0.9 + 0.1 * (i + 1) / r.lines.length });
    await wait(170);
  }
  if (!skip) await wait(650);
  box.classList.add("out"); await wait(420); box.hidden = true; box.classList.remove("out");
  store.set("royal.booted", "1");
}

/* ------------------------------------------------------------ wake --- */
function greeting() {
  const h = new Date().getHours();
  const hi = h < 5 ? "Hey, Tahir." : h < 12 ? "Morning, Tahir." : h < 17 ? "Hey, Tahir." : "Evening, Tahir.";
  const calc = STATUS && STATUS.calculator;
  if (REALM === "BUSINESS" && calc && !calc.connected && !SAID_CALC) { SAID_CALC = true; return hi + " The calculator hasn't checked in, so I can't see the House right now."; }
  return hi;
}

async function wake(e) {
  /* A pointer press already rippled the light on pointerdown (pressStart).
     A keyboard press (Enter or Space: detail 0) ripples from the Core's
     centre, not from the screen's top-left corner where its 0,0 would land. */
  if (e && (e.detail === 0 || !window.PointerEvent)) {
    const g = core.geometry(); core.touchAt(e.detail ? e.clientX : g.x, e.detail ? e.clientY : g.y);
    core.press(true); setTimeout(() => core.press(false), 120);   /* the same squeeze and spring as a finger */
  }
  sound.unlock();
  if (!TOKEN) return;
  /* Realtime voice, when the server offers it: one touch starts a live
     conversation, the next ends it.  Speaking over ROYAL interrupts it. */
  if (rt && !voice.muted) {
    /* While a connection is being made, another touch must not open a second
       one (two microphones, two sockets).  It is ignored until this settles. */
    if (rtStarting || (rt.ws && !rt.active)) return;
    if (rt.active) { rt.stop(); state.go("AWAKE"); stage.setCaption("Voice off. Touch to talk again.", { quiet: true }); settle(); return; }
    if (state.state === "AMBIENT" || state.state === "OFFLINE") state.go("AWAKE", "touch");
    sound.play("wake"); stage.setHeard(""); stage.setCaption("Listening.", { quiet: true });
    rtStarting = true;
    let started = false;
    try { started = await rt.start(); } finally { rtStarting = false; }
    if (started) { bump(); return; }
    /* fall through to the browser's own speech if realtime could not start */
  }
  if (voice.speaking) { voice.stopSpeaking(); settle(); return; }           /* barge-in */
  if (state.state === "LISTENING") { voice.cancel(); state.go("AWAKE"); settle(); return; }
  if (busy) return;
  if (state.state === "AMBIENT" || state.state === "OFFLINE") {
    state.go("AWAKE", "touch"); sound.play("wake");
    const g = greeting(); stage.setHeard(""); stage.setCaption(g);
    /* Say hello (unless muted), then listen; without speech input, offer typing. */
    if (voice.canListen) voice.speak(g.split(".")[0] + ".", { onEnd: () => listenNow() });
    else { voice.speak(g.split(".")[0] + "."); openType(); }
  } else if (voice.canListen) listenNow();
  else openType();
  bump();
}
async function listenNow() { if (state.state === "AWAKE" || state.state === "COMPLETE" || state.state === "WARNING" || state.state === "WAITING_FOR_APPROVAL") await voice.listen(); }

/* Press feedback.  The light answers the moment a finger or mouse button
   lands (pointerdown), instead of waiting for it to lift.  What the press
   does still runs on click, so the keyboard, screen readers and the
   browser's rules for starting sound and the microphone are unchanged. */
let rtStarting = false, lastPointer = "mouse";
function pressStart(e) {
  lastPointer = e.pointerType || "mouse";
  if (!e.isPrimary || e.button > 0) return;
  if (e.currentTarget === $("core") && !$("sheet").hidden) return;   /* that tap closes the menu */
  core.touchAt(e.clientX, e.clientY); core.press(true);
  if (e.pointerType === "touch" || e.pointerType === "pen") sound.tap();
}
/* Let go anywhere (or the press is interrupted): the Core springs back. */
const pressEnd = () => core.press(false);
["pointerup", "pointercancel", "blur"].forEach((t) => addEventListener(t, pressEnd, { passive: true }));
document.addEventListener("visibilitychange", pressEnd);
/* A long press on a phone must not open a text-selection or context menu over the Core. */
function noHoldMenu(e) { if (lastPointer !== "mouse") e.preventDefault(); }
for (const id of ["wake", "core"]) { $(id).addEventListener("pointerdown", pressStart, { passive: true }); $(id).addEventListener("contextmenu", noHoldMenu); }

/* Touch anywhere.  With an answer showing, the column of objects covers most
   of a phone's screen (on a wide screen it sits to one side and the Core's
   open space stays touchable).  A tap on the column's empty space, the
   words or the gaps between cards, is a touch on the Core too, so the
   whole screen answers on every device.  Cards, links and controls keep
   their own taps, a scroll is never a tap, and selecting text wakes nothing. */
const OWN_TAP = "a, button, input, textarea, select, label, summary, details, [role=button], [tabindex], .obj";
$("column").addEventListener("click", (e) => {
  if (document.body.dataset.layout !== "content" || e.target.closest(OWN_TAP)) return;
  const sel = window.getSelection && window.getSelection(); if (sel && String(sel).trim()) return;
  if (!$("sheet").hidden) return closeSheet();
  core.touchAt(e.clientX, e.clientY); core.press(true); setTimeout(() => core.press(false), 120);
  if (e.pointerType === "touch" || e.pointerType === "pen") sound.tap();
  wake(e);
});

$("wake").addEventListener("click", wake);
$("core").addEventListener("click", (e) => { if (!$("sheet").hidden) return closeSheet(); wake(e); });

/* ------------------------------------------------------------ typing --- */
function openType() { unleave($("typebar")); $("typebar").hidden = false; document.body.dataset.typing = "1"; $("say").focus(); if (state.state === "AMBIENT") state.go("AWAKE", "typing"); bump(); }
function closeType() { if ($("typebar").hidden) return; leave($("typebar")); document.body.dataset.typing = "0"; $("say").blur(); }
/* Panels leave the way they arrived (a short fade and slide) instead of
   vanishing; under reduced motion they simply close. */
function leave(el) { if (el.hidden || el._leaving) return; if (reduced) { el.hidden = true; return; } el.classList.add("leaving"); el._leaving = setTimeout(() => { el.hidden = true; el.classList.remove("leaving"); el._leaving = null; }, 200); }
function unleave(el) { if (el._leaving) { clearTimeout(el._leaving); el._leaving = null; el.classList.remove("leaving"); } }
$("kbdBtn").addEventListener("click", () => ($("typebar").hidden || $("typebar")._leaving ? openType() : closeType()));
$("typebar").addEventListener("submit", (e) => { e.preventDefault(); const t = $("say").value.trim(); if (!t) return; $("say").value = ""; submit(t, "text"); });
$("say").addEventListener("input", () => { if (voice.speaking) voice.stopSpeaking(); bump(); });
document.addEventListener("keydown", (e) => {
  if (!TOKEN || !$("signin").hidden || !$("boot").hidden) return;
  if (bots.isOpen) { if (e.key === "Escape") bots.close(); return; }
  const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
  if (e.key === "Escape") { if (!$("sheet").hidden) return closeSheet(); if (voice.speaking) return voice.stopSpeaking(); if (state.state === "LISTENING") { voice.cancel(); return; } if (!$("typebar").hidden) return closeType(); return; }
  if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "/" || (e.key.length === 1 && /\S/.test(e.key))) { openType(); if (e.key !== "/") { $("say").value = e.key; } e.preventDefault(); }
});

/* ------------------------------------------------------------ submit --- */
let busy = false;
async function submit(text, modality, { speak = true } = {}) {
  if (busy) return; busy = true;
  voice.stopSpeaking(); voice.cancel(); sound.unlock();
  stage.setHeard(text); bump();
  if (!STATES[state.state] || state.state === "OFFLINE") state.go("AWAKE");
  state.go("UNDERSTANDING", text);
  const req = api("POST", "/v1/command", { content: text, modality, realm: REALM, conversation_id: CONVO });
  await wait(260);
  state.go("THINKING");
  const r = await req;
  busy = false;
  if (!r.ok) {
    if (r.unauthorized) { store.set("royal.session", null); TOKEN = null; state.go("OFFLINE"); return showSignIn("Your session ended. Sign in again."); }
    state.go("FAILURE", "request failed"); sound.play("failure");
    const spec = { version: 1, mode: "error", realm: REALM, tone: "attention", speech: r.message || "That didn't go through.", focus_entity: null, agents: [],
      surfaces: [{ type: "ERROR_OBJECT", data: { attempted: "Ask ROYAL: " + text.slice(0, 200), failed_because: r.network ? "I couldn't reach my server." : (r.message || "The request failed."), impact: "Nothing was done.", next_action: "Try again in a moment." } }] };
    stage.show(validateSpec(spec).spec); stage.setCaption(spec.speech, { tone: "attention" });
    if (r.network) $("retry").hidden = false;
    return settle();
  }
  const res = r.result;
  const v = validateSpec(res.presentation || {});
  const spec = v.ok ? v.spec : null;
  if (res.status === "FAILED" && /AI brain|PROVIDER_/.test(String(res.summary || ""))) refreshBrain();
  if (!spec) { state.go("FAILURE"); stage.setCaption((res.summary || "") + " (The picture for this answer failed its safety check, so only the words are shown.)", { tone: "attention" }); return settle(); }

  /* Specialists that took part: shown only because they did. */
  if (spec.agents.length) {
    state.go("DELEGATING"); sound.play("delegate");
    stage.showAgents(spec.agents, { hold: 3200 });
    await wait(620 + 90 * spec.agents.length);
    sound.play("returned");
  }
  state.go("RESPONDING");
  stage.show(spec);
  stage.setCaption(spec.speech || res.summary || "", { tone: spec.tone });
  if (res.skill === "clear") stage.setHeard("");
  const done = () => finish(spec, res);
  /* With realtime voice on, the voice says it; the browser stays quiet. */
  if (!speak || (rt && rt.active) || !voice.speak(spec.speech, { onEnd: done })) setTimeout(done, reduced ? 0 : 500);
  return res;
}

function finish(spec, res) {
  if (state.state !== "RESPONDING") return;
  const hasOpen = spec.surfaces.some((p) => p.type === "DECISION_OBJECT" && p.data.status === "OPEN");
  if (res.status === "FAILED") { state.go("FAILURE"); sound.play("failure"); }
  else if (hasOpen) { state.go("WAITING_FOR_APPROVAL"); sound.play("approval"); }
  else if (spec.tone === "alert") { state.go("WARNING"); sound.play("warning"); }
  else { state.go("COMPLETE"); sound.play("complete"); setTimeout(() => { if (state.state === "COMPLETE") state.go("AWAKE"); }, 1600); }
  refreshDecisionMark();
  settle();
}

/* Back to ambient after a quiet spell.  Open decisions stay on screen; the
   Core keeps its amber until they are resolved. */
let idleT = null, recedeT = null;
function bump() { clearTimeout(idleT); clearTimeout(recedeT); }
function settle() {
  bump();
  idleT = setTimeout(() => {
    if (busy || voice.speaking || state.state === "LISTENING" || document.activeElement === $("say")) return settle();
    if (state.state === "WAITING_FOR_APPROVAL") return;
    state.go("AMBIENT", "idle");
    recedeT = setTimeout(() => { if (state.state === "AMBIENT" && !openDecisionOnStage()) { stage.clear(); stage.setHeard(""); stage.setCaption("", { quiet: true }); } }, 150000);
  }, 40000);
}
const openDecisionOnStage = () => !!$("objects").querySelector('.decision.st-OPEN');
["pointerdown", "keydown", "wheel", "touchmove"].forEach((t) => addEventListener(t, bump, { passive: true }));
$("column").addEventListener("scroll", bump, { passive: true });

/* ------------------------------------------------------ interactions --- */
document.addEventListener("click", async (e) => {
  const q = e.target.closest("[data-q]");
  if (q && !q.disabled) { e.preventDefault(); closeSheet(); submit(q.dataset.q, "ui_action"); return; }
  const ed = e.target.closest("[data-edit]"); if (ed) return editDecision(ed.closest("[data-decision]"));
  const rs = e.target.closest("[data-res]"); if (rs) return resolve(rs.closest("[data-decision]"), rs.dataset.res);
});

async function editDecision(card) {
  if (!card || card.querySelector("textarea")) return;
  const r = await api("GET", "/v1/decisions?status=OPEN&realm=" + REALM);
  const d = (r.decisions || []).find((x) => x.id === card.dataset.decision);
  const draft = d && d.action && d.action.args && d.action.args.draft;
  if (!draft) { card.insertAdjacentHTML("beforeend", '<p class="note err">This draft can no longer be edited.</p>'); return; }
  const box = card.querySelector(".draft-b");
  box.innerHTML = '<label class="sr" for="ed-' + esc(d.id) + '">Edit the message</label><textarea id="ed-' + esc(d.id) + '" rows="8">' + esc(draft.body || "") + "</textarea>";
  const ta = box.querySelector("textarea"); ta.focus();
  const acts = card.querySelector(".dec-a");
  acts.innerHTML = '<button type="button" class="act approve" data-mod>Approve edited</button><button type="button" class="act" data-res="REJECT">Reject</button>';
  acts.querySelector("[data-mod]").addEventListener("click", () => resolve(card, "MODIFY", { draft: { ...draft, body: ta.value } }));
}

async function resolve(card, resolution, modified) {
  if (!card) return;
  card.querySelectorAll("button, textarea").forEach((b) => { b.disabled = true; });
  if (state.state === "AMBIENT" || state.state === "OFFLINE") state.go("AWAKE");
  state.go("ACTING", resolution); bump();
  const r = await api("POST", "/v1/decisions/" + encodeURIComponent(card.dataset.decision) + "/resolve", modified ? { resolution, modified_args: modified } : { resolution });
  const d = r.decision, x = (d && d.execution) || r.execution || {};
  let line, tone = "calm";
  if (!d) { line = "Not resolved: " + (r.failed_because || r.message || "unknown reason") + ". Nothing changed."; tone = "attention"; }
  else if (d.status === "REJECTED") line = "Rejected. Nothing was sent or changed.";
  else if (d.status === "VERIFIED") line = "Done, and checked.";
  else if (d.status === "EXECUTED") line = "Done. Not yet independently checked.";
  else if (d.status === "FAILED") { line = "Approved, but carrying it out failed: " + (x.failed_because || "unknown") + "."; tone = "attention"; }
  else if (x.result === "NO_EXECUTOR") line = "Approved and recorded. Nothing was " + (d.action && /send/.test(d.action.tool || "") ? "sent" : "carried out") + ": I can't do this myself yet, so someone on the team needs to.";
  else line = "Recorded as " + String(d.status || "").toLowerCase() + ".";
  const acts = card.querySelector(".dec-a"); if (acts) acts.remove();
  card.classList.remove("st-OPEN"); card.classList.add("st-" + (d ? d.status : "ERR"));
  card.insertAdjacentHTML("beforeend", '<p class="exec resolved">' + esc(line) + "</p>");
  stage.setCaption(line, { tone });
  if (tone === "attention") { state.go("WARNING"); sound.play("warning"); }
  else { state.go("COMPLETE"); sound.play("complete"); setTimeout(() => { if (state.state === "COMPLETE") state.go(openDecisionOnStage() ? "WAITING_FOR_APPROVAL" : "AWAKE"); }, 1400); }
  voice.speak(line.split(". ")[0] + ".");
  refreshDecisionMark(); settle();
}

async function refreshDecisionMark() {
  if (!TOKEN) return;
  const r = await api("GET", "/v1/decisions?status=OPEN&realm=" + REALM);
  const n = r.ok ? r.decisions.length : 0;
  $("decMark").hidden = !n; $("decMark").textContent = n;
  $("menuBtn").setAttribute("aria-label", "Menu" + (n ? ", " + n + " decision" + (n === 1 ? "" : "s") + " waiting" : ""));
}

/* ------------------------------------------------------------ mute --- */
function paintMute() { $("muteBtn").setAttribute("aria-pressed", voice.muted ? "true" : "false"); $("muteBtn").setAttribute("aria-label", voice.muted ? "Spoken replies off" : "Spoken replies on"); document.body.dataset.muted = voice.muted ? "1" : "0"; }
$("muteBtn").addEventListener("click", () => { voice.setMuted(!voice.muted); paintMute(); });
paintMute();

/* ------------------------------------------------------------- bots --- */
/* The external Grok Bots, each in its own tab with its own live feed. */
const bots = new BotsPanel({ root: $("bots"), api, token: () => TOKEN, realm: () => REALM, base: CFG.API || "",
  onOpen: () => { bump(); closeType(); }, onClose: () => { $("menuBtn").focus({ preventScroll: true }); settle(); } });

/* ------------------------------------------------------------ sheet --- */
function openSheet(view = "home") { unleave($("sheet")); $("sheet").hidden = false; document.body.dataset.menu = "1"; showSheet(view); bump(); }
function closeSheet() { if ($("sheet").hidden || $("sheet")._leaving) return; leave($("sheet")); document.body.dataset.menu = "0"; $("menuBtn").focus({ preventScroll: true }); }
$("menuBtn").addEventListener("click", () => ($("sheet").hidden || $("sheet")._leaving ? openSheet() : closeSheet()));
$("sheetClose").addEventListener("click", closeSheet);

async function showSheet(view) {
  const body = $("sheetBody");
  const back = view === "home" ? "" : '<button type="button" class="sb-back" data-sheet="home">‹ Menu</button>';
  if (view === "home") {
    body.innerHTML =
      '<p class="sb-h">Context</p><div class="seg" role="group" aria-label="Context">' +
        '<button type="button" data-realm="BUSINESS" aria-pressed="' + (REALM === "BUSINESS") + '">Business</button><button type="button" data-realm="PERSONAL" aria-pressed="' + (REALM === "PERSONAL") + '">Personal</button></div>' +
      '<p class="sb-note">' + (REALM === "PERSONAL" ? "Personal is kept apart from the business: its own conversation, decisions and activity." : "The House of Royal T, Tahir & Co., Gold Buy and operations.") + "</p>" +
      '<ul class="sb-list">' +
        '<li><button type="button" data-sheet="decisions">Decisions<span id="sbDec"></span></button></li>' +
        '<li><button type="button" data-sheet="activity">Activity</button></li>' +
        '<li><button type="button" data-sheet="agents">Specialists</button></li>' +
        '<li><button type="button" data-sheet="bots">Bots</button></li>' +
        '<li><button type="button" data-sheet="systems">Systems</button></li>' +
      "</ul>" +
      '<p class="sb-h">Preferences</p><ul class="sb-list">' +
        '<li><label class="tg"><span>Spoken replies</span><input type="checkbox" data-pref="voice"' + (voice.muted ? "" : " checked") + (voice.canSpeak ? "" : " disabled") + "></label></li>" +
        '<li><label class="tg"><span>Sounds</span><input type="checkbox" data-pref="sound"' + (sound.enabled ? " checked" : "") + "></label></li>" +
        (voice.canListen ? "" : '<li class="sb-note">Voice input isn\'t available in this browser. Typing works everywhere.</li>') +
      "</ul>" +
      '<ul class="sb-list"><li><button type="button" id="signOut" class="danger">Sign out</button></li></ul>';
    const r = await api("GET", "/v1/decisions?status=OPEN&realm=" + REALM);
    const n = r.ok ? r.decisions.length : 0; const s = $("sbDec"); if (s && n) s.textContent = " · " + n + " waiting";
    return;
  }
  body.innerHTML = back + '<p class="sb-load">Loading…</p>';
  if (view === "decisions") {
    const r = await api("GET", "/v1/decisions?realm=" + REALM);
    const all = r.decisions || [], open = all.filter((d) => d.status === "OPEN"), done = all.filter((d) => d.status !== "OPEN").slice(0, 20);
    body.innerHTML = back + '<h2 class="sb-t">Decisions</h2>' +
      (open.length ? '<p class="sb-note">' + open.length + " waiting on you.</p>" + '<button type="button" class="act approve wide" data-q="What needs my approval?">Review them with ROYAL</button>' : '<p class="sb-note">Nothing is waiting on you.</p>') +
      (done.length ? '<p class="sb-h">Resolved</p><ol class="sb-ledger">' + done.map((d) => "<li><span>" + esc(d.title) + "</span><em>" + esc(String(d.status).toLowerCase()) + "</em></li>").join("") + "</ol>" : "");
  } else if (view === "activity") {
    const r = await api("GET", "/v1/activity?realm=" + REALM);
    const a = r.activity || [];
    body.innerHTML = back + '<h2 class="sb-t">Activity</h2>' + (a.length ? '<ol class="sb-ledger">' + a.slice(0, 80).map((x) => "<li><time>" + esc(new Date(x.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) + "</time><span>" + esc(x.summary || x.action) + "</span></li>").join("") + "</ol>" : '<p class="sb-note">No activity recorded yet.</p>');
  } else if (view === "agents") {
    const r = await api("GET", "/v1/agents");
    const list = (r.agents || []).filter((a) => a.id !== "royal");
    body.innerHTML = back + '<h2 class="sb-t">Specialists</h2><p class="sb-note">They report to ROYAL. You only ever talk to ROYAL.</p><ul class="sb-agents">' + list.map((a) =>
      '<li class="h-' + esc(a.health || a.status) + '"><i aria-hidden="true"></i><div><b>' + esc(a.name) + "</b> <span>" + esc(a.role || "") + "</span>" +
      '<p class="sb-note">' + esc(a.health === "NOT_CONNECTED" || a.status === "NOT_CONNECTED" ? "Not connected yet." : (a.capabilities || []).slice(0, 4).map((c) => String(c).replace(/_/g, " ")).join(" · ")) + "</p>" +
      (a.last_activity ? '<p class="sb-note">Last: ' + esc(new Date(a.last_activity.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) + "</p>" : "") + "</div></li>").join("") + "</ul>";
  } else if (view === "systems") {
    const r = await api("GET", "/v1/boot");
    const lines = r.lines || [];
    body.innerHTML = back + '<h2 class="sb-t">Systems</h2><ul class="sb-sys">' + lines.map((l) => '<li class="' + (l.ok ? "ok" : "no") + '"><span>' + esc(l.k) + "</span><em>" + esc(l.v) + (l.detail ? " · " + esc(l.detail) : "") + "</em></li>").join("") + "</ul>" +
      '<div class="sb-row"><button type="button" class="act" id="testGrok">Test Grok</button><span id="grokOut" class="sb-note" role="status"></span></div>' +
      intelLines() +
      '<p class="sb-h">Rendering</p><div class="seg" role="group" aria-label="Quality">' + ["HIGH", "MEDIUM", "LOW"].map((t) => '<button type="button" data-tier="' + t + '" aria-pressed="' + (core.tierName === t) + '">' + t[0] + t.slice(1).toLowerCase() + "</button>").join("") + "</div>" +
      '<p class="sb-note">Renderer: ' + esc(core.mode === "webgl" ? "WebGL" : core.mode === "2d" ? "2D fallback" : "none") + (reduced ? " · reduced motion" : "") + "</p>" +
      '<ul class="sb-list"><li><button type="button" id="replayBoot">Replay start-up</button></li></ul>';
  }
}

function intelLines() {
  const i = INTEL; if (!i) return "";
  /* Measured on this device: the median time from the question to the
     first sound, and how many gaps the voice has had. */
  const voiceLine = () => {
    const st = (rt && rt.pb && rt.pb.stats && rt.pb.stats.replies ? rt.pb.stats : null) || voice.stats;
    if (!st || !st.replies) return "";
    const f = st.first_audio_ms.slice().sort((a, b) => a - b), med = f.length ? f[Math.floor(f.length / 2)] : null;
    return (med !== null ? " · first sound " + med + " ms" : "") + " · " + st.underruns + (st.underruns === 1 ? " gap" : " gaps");
  };
  const row = (k, v, ok) => '<li class="' + (ok ? "ok" : "no") + '"><span>' + esc(k) + "</span><em>" + esc(v) + "</em></li>";
  const word = (x) => String(x || "unknown").toLowerCase().replace(/_/g, " ");
  return '<p class="sb-h">Intelligence</p><ul class="sb-sys">' +
    row("WEB RESEARCH", word(i.research.status) + (i.research.detail ? " · " + i.research.detail : ""), i.research.status === "CONNECTED") +
    row("HOUSE KNOWLEDGE", i.knowledge.status === "CONNECTED" ? i.knowledge.documents + " documents · " + i.knowledge.passages + " passages" : word(i.knowledge.status), i.knowledge.status === "CONNECTED") +
    row("CONTACT DISCOVERY", word(i.contacts.discovery), i.contacts.discovery === "CONNECTED") +
    row("EMAIL VERIFICATION", word(i.contacts.verification), i.contacts.verification === "CONNECTED") +
    row("EMAIL SENDING", word(i.email.status) + " · " + word(i.sending), i.email.status === "CONNECTED" && i.sending === "ENABLED") +
    row("REALTIME VOICE", word(i.realtime_voice), i.realtime_voice === "AVAILABLE") +
    row("ROYAL'S VOICE", word(i.spoken_voice || "DISABLED") + voiceLine(), i.spoken_voice === "AVAILABLE") +
    row("GROK BOT AGENTS", word(i.agent_orchestration), i.agent_orchestration === "ENABLED") + "</ul>";
}

$("sheetBody").addEventListener("click", async (e) => {
  const sv = e.target.closest("#sheetBody [data-sheet]");
  if (sv && sv.dataset.sheet === "bots") { closeSheet(); return bots.open(); }
  if (sv) return showSheet(sv.dataset.sheet);
  const rg = e.target.closest("#sheetBody [data-realm]"); if (rg) { switchRealm(rg.dataset.realm); return showSheet("home"); }
  const tr = e.target.closest("#sheetBody [data-tier]"); if (tr) { core.setTier(tr.dataset.tier); return showSheet("systems"); }
  if (e.target.id === "signOut") { store.set("royal.session", null); TOKEN = null; location.reload(); return; }
  if (e.target.id === "replayBoot") { closeSheet(); state.go("AMBIENT"); await runBoot(); state.go("AMBIENT"); return; }
  if (e.target.id === "testGrok") {
    e.target.disabled = true; $("grokOut").textContent = "Testing…";
    const t = await api("POST", "/v1/provider/test");
    e.target.disabled = false;
    const why = !t.ok && providerProblem(t);
    $("grokOut").textContent = t.ok ? "Grok answered" + (t.model ? " (" + t.model + ")" : "") + (t.latency_ms ? " in " + t.latency_ms + " ms" : "") + "." : why ? "Grok did not answer: " + why.why + ". " + why.fix : "Grok did not answer: " + String(t.message || "unknown reason").replace(/\.+$/, "") + ".";
    refreshBrain();
  }
});
$("sheetBody").addEventListener("change", (e) => {
  const p = e.target.dataset.pref;
  if (p === "voice") { voice.setMuted(!e.target.checked); paintMute(); }
  if (p === "sound") sound.setEnabled(e.target.checked);
});

/* Business and Personal are separate rooms: a new conversation, a cleared
   stage, and their own decisions and activity. */
function switchRealm(r) {
  if (r === REALM || ["BUSINESS", "PERSONAL"].indexOf(r) < 0) return;
  REALM = r; store.set("royal.realm", r); CONVO = newConvo();
  stage.history = []; stage.clear(); stage.setHeard("");
  bots.reset();
  /* A live voice conversation belongs to the room it started in. */
  if (rt && rt.active) rt.stop();
  applyRealm();
  stage.setCaption(r === "PERSONAL" ? "Personal. Nothing from the business comes in here." : "Business.", { quiet: true });
  refreshDecisionMark();
}
function applyRealm() { document.body.dataset.realm = REALM; $("realmLbl").textContent = REALM === "PERSONAL" ? "Personal" : "Business"; }

/* ------------------------------------------------------------ clock --- */
/* A quiet local time in the corner (wide screens), true and nothing more. */
function tick() { $("clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
tick(); setInterval(tick, 15000);

/* ------------------------------------------------------------- go --- */
window.addEventListener("error", (e) => { const n = $("fatal"); if (n) { n.hidden = false; n.textContent = "ROYAL hit an error (" + (e.message || "unknown") + "). Reload the page; if it keeps happening, check that every file in web/ is from the same version."; } });
start();
