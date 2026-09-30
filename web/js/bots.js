/* The Bots view: talk to each external Grok Bot directly, and watch each
   one's live feed on its own.

   One tab per bot.  Each tab owns its own state (events, last event id,
   draft, stream) and nothing is shared between tabs; switching tabs closes
   the old tab's stream and resumes the new one from where it left off.
   Bots that do not work in the current realm are not shown at all (the
   server hides them too). */

import { openStream } from "./sse.js";
import { renderMarkdown } from "./markdown.js";

const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = (t) => { try { return new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch (_) { return ""; } };
const TYPE = { outbound: "You", progress: "Working", result: "Result", alert: "Alert", message: "Message" };
const STATUS = { CONNECTED: "Connected", NOT_CONNECTED: "Not connected", DISABLED: "Switched off" };

export class BotsPanel {
  constructor({ root, api, token, realm, base = "", onOpen, onClose }) {
    Object.assign(this, { root, api, token, realm, base, onOpen, onClose });
    this.tabs = new Map();   /* bot id -> { events, lastId, draft, stream, live, loaded } */
    this.bots = []; this.active = null; this.meta = null;
    root.addEventListener("click", (e) => this._click(e));
    root.addEventListener("submit", (e) => this._submit(e));
    root.addEventListener("input", (e) => { if (e.target.name === "content" && this.active) this._tab(this.active).draft = e.target.value; this._count(); });
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); this.close(); }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.target.name === "content") { e.preventDefault(); this.root.querySelector(".bp-send").requestSubmit(); }
    });
  }

  get isOpen() { return !this.root.hidden; }
  _tab(id) { if (!this.tabs.has(id)) this.tabs.set(id, { events: [], lastId: null, draft: "", stream: null, live: "idle", loaded: false, note: "" }); return this.tabs.get(id); }

  async open() {
    this.root.hidden = false; document.body.dataset.bots = "1";
    if (this.onOpen) this.onOpen();
    this.root.innerHTML = '<div class="bp"><header class="bp-top"><h2 class="bp-title">Bots</h2><p class="bp-sub" id="bpSub"></p><p class="bp-warn" id="bpWarn" role="note" hidden></p>' +
      '<button type="button" class="glyph bp-x" data-close aria-label="Close bots"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></header>' +
      '<nav class="bp-tabs" role="tablist" aria-label="Bots"></nav><section class="bp-body" aria-live="polite"><p class="bp-note">Loading…</p></section></div>';
    const r = await this.api("GET", "/v1/bots?realm=" + this.realm());
    const body = this.root.querySelector(".bp-body");
    if (!r.ok) { body.innerHTML = '<p class="bp-note err">' + esc(r.message || r.error || "The bots couldn't be loaded.") + "</p>"; return; }
    this.meta = r; this.bots = r.bots || [];
    this.root.querySelector("#bpSub").textContent = (this.realm() === "PERSONAL" ? "Personal · only bots allowed in Personal" : "Business") +
      (r.enabled ? "" : " · the bridge is switched off on the server");
    /* Said plainly, where it can't be missed: without a database nothing here survives a restart. */
    const warn = this.root.querySelector("#bpWarn");
    if (r.storage === "TEMPORARY") { warn.textContent = "Temporary storage: bot messages and tokens are kept in the server's memory and are erased whenever it restarts or redeploys. Attach a database (DATABASE_URL) to keep them."; warn.hidden = false; }
    if (!this.bots.length) { body.innerHTML = '<p class="bp-note">No bots work in ' + esc(this.realm().toLowerCase()) + ".</p>"; this._tabs(); return; }
    const keep = this.active && this.bots.some((b) => b.id === this.active) ? this.active : this.bots[0].id;
    this.active = null;
    this.select(keep);
  }

  close() {
    this._stopAll();
    this.root.hidden = true; document.body.dataset.bots = "0";
    if (this.onClose) this.onClose();
  }

  /* Realm switch: nothing carries over. */
  reset() { this._stopAll(); this.tabs.clear(); this.active = null; if (this.isOpen) this.open(); }

  _stopAll() { for (const t of this.tabs.values()) { if (t.stream) { t.stream.close(); t.stream = null; t.live = "idle"; } } }

  _tabs() {
    const nav = this.root.querySelector(".bp-tabs"); if (!nav) return;
    nav.innerHTML = this.bots.map((b) => '<button type="button" role="tab" data-bot="' + esc(b.id) + '" aria-selected="' + (b.id === this.active) + '" class="bp-tab st-' + esc(b.status) + (b.last_error ? " has-err" : "") + '">' +
      '<i aria-hidden="true"></i><span>' + esc(b.name) + "</span></button>").join("");
  }

  async select(id) {
    if (id === this.active) return;
    if (this.active) { const old = this._tab(this.active); if (old.stream) { old.stream.close(); old.stream = null; old.live = "idle"; } }
    this.active = id; this._tabs();
    const t = this._tab(id);
    this._paint();
    if (!t.loaded) {
      const r = await this.api("GET", "/v1/bots/" + encodeURIComponent(id) + "/feed?limit=200&realm=" + this.realm());
      if (this.active !== id) return;
      if (r.ok) { t.events = r.events || []; t.lastId = r.next_since || (t.events.length ? t.events[t.events.length - 1].id : null); t.loaded = true; }
      else t.note = r.message || r.error || "This feed couldn't be loaded.";
      this._paint();
    }
    this._listen(id);
  }

  _listen(id) {
    const t = this._tab(id);
    if (t.stream) return;
    const path = this.base + "/v1/bots/" + encodeURIComponent(id) + "/stream?realm=" + this.realm();
    t.stream = openStream(path, { token: this.token, since: t.lastId,
      onEvent: (e) => {
        if (e.bot_id !== id) return;                            /* never another bot's event in this tab */
        if (t.events.some((x) => x.id === e.id)) return;
        t.events.push(e); t.lastId = e.id; if (t.events.length > 500) t.events.shift();
        if (this.active === id) this._append(e);
      },
      onStatus: (s) => { t.live = s; if (this.active === id) this._live(); },
      onReset: () => {                                           /* too much was missed to replay: reload this tab */
        t.stream = null; t.loaded = false; t.events = []; t.lastId = null;
        if (this.active === id) { this.active = null; this.select(id); }
      } });
  }

  _paint() {
    const id = this.active, bot = this.bots.find((b) => b.id === id), t = this._tab(id);
    const body = this.root.querySelector(".bp-body"); if (!body || !bot) return;
    const canSend = bot.status === "CONNECTED";
    body.innerHTML =
      '<div class="bp-head"><p class="bp-state st-' + esc(bot.status) + '"><i aria-hidden="true"></i>' + esc(STATUS[bot.status] || bot.status) +
        (bot.config_error ? " · " + esc(bot.config_error.replace(/_/g, " ").toLowerCase()) : "") + '<span class="bp-live" id="bpLive"></span></p>' +
        '<p class="bp-meta">' + (bot.last_seen ? "Last heard " + esc(when(bot.last_seen)) : "Hasn't reported yet") + (bot.last_message_at ? " · last asked " + esc(when(bot.last_message_at)) : "") +
        (bot.last_error ? ' · <span class="bp-err">last delivery failed (' + esc(bot.last_error) + ")</span>" : "") + "</p>" +
        '<p class="bp-meta">Works in ' + esc(bot.realms.map((r) => r.toLowerCase()).join(" and ")) + '. <button type="button" class="lnk" data-token-menu>Token</button></p><div class="bp-token" hidden></div></div>' +
      '<ol class="bp-feed" aria-label="' + esc(bot.name) + ' feed">' + (t.events.length ? t.events.map((e) => this._event(e)).join("") : "") + "</ol>" +
      (t.events.length ? "" : '<p class="bp-note bp-empty">' + esc(t.note || "Nothing from " + bot.name + " yet.") + "</p>") +
      '<form class="bp-send" autocomplete="off"><label class="sr" for="bpContent">Message to ' + esc(bot.name) + "</label>" +
        '<textarea id="bpContent" name="content" rows="2" maxlength="2000" placeholder="' + esc(canSend ? "Message " + bot.name : bot.name + " can't be reached from here yet") + '"' + (canSend ? "" : " disabled") + ">" + esc(t.draft) + "</textarea>" +
        '<div class="bp-row"><label class="sr" for="bpSkill">Skill (optional)</label><input id="bpSkill" name="skill" maxlength="64" placeholder="skill (optional)"' + (canSend ? "" : " disabled") + '>' +
        '<span class="bp-count" id="bpCount"></span><button type="submit" class="act approve"' + (canSend ? "" : " disabled") + ">Send</button></div>" +
        '<p class="bp-note bp-status" role="status"></p></form>';
    this._live(); this._count(); this._scroll();
  }

  _event(e) {
    const mine = e.type === "outbound";
    return '<li class="bp-ev t-' + esc(e.type) + (mine ? " mine" : "") + (e.status === "failed" ? " failed" : "") + '"><p class="bp-ev-h"><span>' + esc(TYPE[e.type] || e.type) + "</span>" +
      (e.status ? "<em>" + esc(String(e.status).replace(/_/g, " ")) + "</em>" : "") + "<time>" + esc(when(e.created_at)) + "</time></p>" +
      '<div class="bp-md">' + (mine ? "<p>" + esc(e.content_markdown).replace(/\n/g, "<br>") + "</p>" : renderMarkdown(e.content_markdown)) + "</div></li>";
  }
  _append(e) {
    const feed = this.root.querySelector(".bp-feed"); if (!feed) return;
    const empty = this.root.querySelector(".bp-empty"); if (empty) empty.remove();
    const nearBottom = this._body().scrollHeight - this._body().scrollTop - this._body().clientHeight < 120;
    feed.insertAdjacentHTML("beforeend", this._event(e));
    if (nearBottom || e.type === "outbound") this._scroll();
  }
  _body() { return this.root.querySelector(".bp-body"); }
  _scroll() { const b = this._body(); if (b) b.scrollTop = b.scrollHeight; }
  _live() {
    const el = this.root.querySelector("#bpLive"); if (!el || !this.active) return;
    const s = this._tab(this.active).live;
    el.textContent = { live: " · live", connecting: " · connecting", reconnecting: " · reconnecting", forbidden: " · not available here", signed_out: " · signed out" }[s] || "";
    el.dataset.s = s;
  }
  _count() { const ta = this.root.querySelector("#bpContent"), c = this.root.querySelector("#bpCount"); if (ta && c) c.textContent = ta.value.length > 1600 ? ta.value.length + " / 2000" : ""; }

  async _submit(e) {
    if (!e.target.classList.contains("bp-send")) return;
    e.preventDefault();
    const id = this.active, f = e.target, content = f.content.value.trim(), skill = f.skill.value.trim();
    if (!content) return;
    const btn = f.querySelector("button[type=submit]"), st = f.querySelector(".bp-status");
    btn.disabled = true; st.textContent = "Sending…"; st.classList.remove("err");
    const r = await this.api("POST", "/v1/bots/" + encodeURIComponent(id) + "/message", { content, ...(skill ? { skill } : {}), realm: this.realm() });
    if (this.active !== id) return;
    btn.disabled = false;
    if (r.ok) { f.content.value = ""; this._tab(id).draft = ""; st.textContent = "Delivered. Replies appear here as the bot posts them."; }
    else { st.textContent = r.message || r.error || "Not sent."; st.classList.add("err"); }
    this._count();
    /* refresh each bot's status dot (a failed delivery turns it amber) */
    const l = await this.api("GET", "/v1/bots?realm=" + this.realm());
    if (l.ok && this.isOpen) { this.bots = l.bots || this.bots; this._tabs(); }
  }

  async _click(e) {
    if (e.target.closest("[data-close]")) return this.close();
    const tab = e.target.closest("[data-bot]"); if (tab) return this.select(tab.dataset.bot);
    const box = this.root.querySelector(".bp-token");
    if (e.target.closest("[data-token-menu]")) {
      box.hidden = !box.hidden;
      box.innerHTML = '<p class="bp-note">A token lets this bot post to its own feed and read its own requests. Nothing else. Issuing a new one stops the old one.</p>' +
        '<div class="bp-row"><button type="button" class="act" data-token-new>Issue new token</button><button type="button" class="act" data-token-revoke>Revoke</button></div><div class="bp-token-out"></div>';
      return;
    }
    const outEl = box && box.querySelector(".bp-token-out");
    if (e.target.closest("[data-token-new]")) {
      const b = e.target.closest("[data-token-new]");
      if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "Confirm: replace the token"; return; }
      const r = await this.api("POST", "/v1/bots/" + encodeURIComponent(this.active) + "/token");
      if (!r.ok) { outEl.innerHTML = '<p class="bp-note err">' + esc(r.message || r.error) + "</p>"; return; }
      outEl.innerHTML = '<p class="bp-note">Shown once. Paste it into this bot\'s secure secret input, never into a chat. Reply endpoint: <code>' + esc(r.reply_endpoint) + "</code></p>" +
        '<div class="bp-row"><input class="bp-tok" readonly value="' + esc(r.token) + '" aria-label="New token"><button type="button" class="act" data-copy>Copy</button></div>';
      return;
    }
    if (e.target.closest("[data-copy]")) {
      const i = box.querySelector(".bp-tok"); i.select();
      try { await navigator.clipboard.writeText(i.value); e.target.textContent = "Copied"; } catch (_) { e.target.textContent = "Select and copy"; }
      return;
    }
    if (e.target.closest("[data-token-revoke]")) {
      const b = e.target.closest("[data-token-revoke]");
      if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "Confirm revoke"; return; }
      const r = await this.api("DELETE", "/v1/bots/" + encodeURIComponent(this.active) + "/token");
      outEl.innerHTML = '<p class="bp-note">' + esc(r.ok ? (r.revoked ? "Revoked. The bot can no longer post until it gets a new token." : "There was no active token.") : (r.message || r.error)) + "</p>";
    }
  }
}
