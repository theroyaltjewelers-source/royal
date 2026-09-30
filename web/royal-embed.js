/* ROYAL embed client.  Loaded by a host application (the Royal T Project
   Calculator first) to do two things:

     1. Send the host's verified state to ROYAL, through the host's own House
        API, when it loads and after it saves.
     2. Ask ROYAL questions from inside the host and draw the answer there.

   It holds no intelligence of its own.  The ROYAL service decides; this file
   carries messages.  Plain script, no modules, so any page can load it.

     ROYALEmbed.init({
       api:         "https://royal.example.com",   // the ROYAL service
       getToken:    () => Promise<string|null>,     // the host's signed-in access token
       getSnapshot: () => object|null,              // the host's House API snapshot
     })
*/
(function () {
  "use strict";
  var S = { api: "", getToken: null, getSnapshot: null, timer: null, last: 0, status: "NOT_CONNECTED", listeners: [] };

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function setStatus(s, detail) { S.status = s; S.listeners.forEach(function (f) { try { f(s, detail); } catch (e) { /* host listener */ } }); }

  function call(method, path, body) {
    return Promise.resolve(S.getToken ? S.getToken() : null).then(function (t) {
      if (!t) throw new Error("NOT_SIGNED_IN");
      return fetch(S.api + path, { method: method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + t },
        body: body ? JSON.stringify(body) : undefined });
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok && j.ok !== true) { var e = new Error(j.message || j.error || ("HTTP " + r.status)); e.code = j.error; throw e; } return j; }); });
  }

  /* Push the House API snapshot.  Debounced: a burst of saves sends once. */
  function push(now) {
    clearTimeout(S.timer);
    var go = function () {
      var snap = null;
      try { snap = S.getSnapshot && S.getSnapshot(); } catch (e) { setStatus("ERROR", "snapshot failed: " + e.message); return; }
      if (!snap) return;
      call("POST", "/v1/ingest/calculator", { snapshot: snap, transport: "embedded" })
        .then(function (r) { S.last = Date.now(); setStatus(r.ok ? "CONNECTED" : "ERROR", r.ok ? null : (r.errors || []).join("; ")); })
        .catch(function (e) { setStatus(e.message === "NOT_SIGNED_IN" ? "NOT_CONNECTED" : "ERROR", e.message); });
    };
    if (now) go(); else S.timer = setTimeout(go, 2500);
  }

  function ask(content, context) {
    return call("POST", "/v1/command", { content: content, context: context || {}, conversation_id: "embed" }).then(function (j) { return j.result; });
  }

  var RISK = { GREEN: "Healthy", YELLOW: "Watch", ORANGE: "At risk", RED: "Serious", BLACK: "Critical" };
  /* A compact rendering for a side panel.  Full surfaces live in the ROYAL
     app; the panel links there for anything larger. */
  function render(r) {
    var s = r.surface || {}, items = s.items || s.before || s.exceptions || (s.type === "briefing" ? [] : r.findings) || [];
    var h = "<div class='rimsg royal'><b>" + esc(r.summary) + "</b>";
    if (s.type === "project" && s.answer) {
      h += "<ul>" + [["Why", s.answer.why], ["Owner", s.answer.owner], ["Next", s.answer.next_action], ["Risk", RISK[s.answer.risk]]]
        .filter(function (x) { return x[1]; }).map(function (x) { return "<li>" + esc(x[0]) + ": " + esc(x[1]) + "</li>"; }).join("") + "</ul>";
    } else if (items.length) {
      h += "<ul>" + items.slice(0, 6).map(function (i) {
        return "<li><span class='pri'>" + esc(i.priority || "") + "</span> " + esc(i.title) + (i.entity && i.entity.client_name ? " · " + esc(i.entity.client_name) : "") +
          (i.evidence && i.evidence.label && i.evidence.label !== "VERIFIED" ? " <i>(" + esc(i.evidence.label.toLowerCase().replace(/_/g, " ")) + ")</i>" : "") + "</li>";
      }).join("") + "</ul>";
    } else if (s.type === "changes" && s.changes) {
      h += "<ul>" + s.changes.slice(0, 6).map(function (c) { return "<li>" + esc(c.text) + "</li>"; }).join("") + "</ul>";
    } else if (s.type === "clarify") {
      h += "<ul>" + s.candidates.map(function (c) { return "<li>" + esc(c.id + " · " + (c.client_name || "") + " · " + (c.name || "")) + "</li>"; }).join("") + "</ul>";
    }
    if (r.connection && r.connection.connected) h += "<div class='rinote'>Calculator " + esc(r.connection.age) + ".</div>";
    return h + "</div>";
  }

  window.ROYALEmbed = {
    init: function (o) {
      S.api = String(o.api || "").replace(/\/$/, ""); S.getToken = o.getToken; S.getSnapshot = o.getSnapshot;
      if (!S.api) { setStatus("NOT_CONNECTED", "no ROYAL address configured"); return false; }
      push(true);
      return true;
    },
    push: function () { push(false); },
    pushNow: function () { push(true); },
    ask: ask, render: render,
    onStatus: function (f) { S.listeners.push(f); f(S.status); },
    status: function () { return S.status; },
    appUrl: function () { return S.api + "/"; },
  };
})();
