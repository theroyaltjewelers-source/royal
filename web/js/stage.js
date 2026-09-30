/* The stage: where ROYAL's answers take physical form around the Core.

   Two layouts, chosen by what is on screen, never by a menu:
     rest     the Core alone, centred, with ROYAL's words beneath it
     content  the Core rises (phones) or moves aside (wide screens) and the
              objects of the answer materialize in a column beside it

   Agent nodes are drawn only for specialists that actually took part in the
   answer (spec.agents, which the server builds from real delegations).
   Nothing is placed here that the server did not send. */

import { render, esc } from "./primitives.js";

const wide = () => innerWidth >= 1000 && innerWidth / innerHeight > 1.2;

export class Stage {
  constructor({ core, column, objects, caption, heard, agents, reduced }) {
    Object.assign(this, { core, column, objects, caption, heard, agents, reduced });
    this.spec = null; this.history = []; this.mode = "rest"; this.nodeTimer = null;
    addEventListener("resize", () => this.layout());
    this.layout();
  }

  /* Where the Core should be for the current layout (fractions of the
     viewport), and where the column of objects goes (CSS pixels). */
  target() {
    const W = innerWidth, H = innerHeight, m = Math.min(W, H);
    if (this.mode === "rest") {
      const r = W < 600 ? 0.2 : 0.17, cy = W < 600 ? 0.4 : 0.42;
      const top = cy * H + r * m * 1.35 + 18;
      return { core: { cx: 0.5, cy, r }, col: { left: Math.max(16, (W - 620) / 2), width: Math.min(620, W - 32), top } };
    }
    if (wide()) {
      const r = 0.15, cx = 0.24, cy = 0.46;
      const left = Math.round(W * 0.44), width = Math.min(680, W - left - 40);
      return { core: { cx, cy, r }, col: { left, width, top: 56 } };
    }
    const r = W < 600 ? 0.1 : 0.085, px = r * m;
    const cy = (px * 1.25 + 40) / H;
    return { core: { cx: 0.5, cy, r }, col: { left: Math.max(16, (W - 620) / 2), width: Math.min(620, W - 32), top: cy * H + px * 1.3 + 16 } };
  }

  layout() {
    const t = this.target();
    this.core.setLayout(t.core);
    const s = this.column.style;
    s.setProperty("--col-left", t.col.left + "px"); s.setProperty("--col-width", t.col.width + "px"); s.setProperty("--col-top", t.col.top + "px");
    document.body.dataset.layout = this.mode; document.body.dataset.wide = wide() ? "1" : "0";
    this._placeNodes();
    if (this.onLayout) this.onLayout(this.coreBox());
  }

  /* The Core's resting box in CSS pixels, for the touch target. */
  coreBox() {
    const t = this.target().core, m = Math.min(innerWidth, innerHeight);
    return { x: t.cx * innerWidth, y: t.cy * innerHeight, r: t.r * m };
  }

  setHeard(text) { this.heard.textContent = text ? "“" + text + "”" : ""; this.heard.hidden = !text; }
  setCaption(text, { tone = "calm", quiet = false } = {}) {
    this.caption.textContent = text || "";
    this.caption.dataset.tone = tone; this.caption.classList.toggle("quiet", !!quiet); this.caption.classList.toggle("long", (text || "").length > 110);
    this.caption.classList.remove("in"); void this.caption.offsetWidth; this.caption.classList.add("in");
  }

  /* Show a presentation spec.  Old objects recede, new ones materialize in
     order.  Returns once the new objects are in the document. */
  show(spec, { remember = true } = {}) {
    if (spec.mode === "back") return this.back();
    if (spec.mode === "ambient" || !spec.surfaces.length) {
      if (remember && this.spec && this.spec.surfaces.length) this.history.push(this.spec);
      this.spec = spec; this._swap(""); this.mode = "rest"; this.layout(); return;
    }
    if (remember && this.spec && this.spec.surfaces.length) { this.history.push(this.spec); if (this.history.length > 12) this.history.shift(); }
    this.spec = spec;
    const html = spec.surfaces.map((p, i) => '<div class="m">' + render(p, i) + "</div>").join("");
    this.mode = "content"; this.layout();
    this._swap(html);
  }

  back() {
    const prev = this.history.pop();
    if (!prev) { this.clear(); return null; }
    this.spec = null; this.show(prev, { remember: false }); return prev;
  }

  clear() { this.spec = null; this._swap(""); this.mode = "rest"; this.layout(); }

  _swap(html) {
    const old = Array.from(this.objects.children);
    old.forEach((n) => { n.classList.add("out"); n.setAttribute("aria-hidden", "true"); });
    const drop = () => old.forEach((n) => n.remove());
    if (this.reduced) drop(); else setTimeout(drop, 240);
    if (html) {
      const wrap = document.createElement("div"); wrap.className = "set"; wrap.innerHTML = html;
      /* stagger order is set through the CSSOM: the page's CSP allows no inline style attributes */
      Array.from(wrap.children).forEach((n, i) => n.style.setProperty("--i", Math.min(i, 10)));
      this.objects.appendChild(wrap);
      this.column.scrollTop = 0;
    }
  }

  /* ---------------------------------------------------------- agents --- */
  /* Materialize a node for each specialist that took part, feed the Core the
     beam endpoints, and let them recede after a while. */
  showAgents(list, { hold = 2600 } = {}) {
    clearTimeout(this.nodeTimer);
    this.agentList = (list || []).slice(0, 6);
    this.agents.innerHTML = this.agentList.map((a, i) =>
      '<div class="node st-' + esc(a.state) + '"><i aria-hidden="true"></i><span class="nn">' + esc(a.name) + '</span><span class="ns">' +
      esc({ reported: "reported", did_not_report: "didn't report", not_connected: "not connected" }[a.state] || a.state) + "</span></div>").join("");
    Array.from(this.agents.children).forEach((n, i) => n.style.setProperty("--i", i));
    this.agents.hidden = !this.agentList.length;
    this._placeNodes(true);
    if (this.agentList.length) requestAnimationFrame(() => this.agents.classList.add("on"));
    if (hold) this.nodeTimer = setTimeout(() => this.hideAgents(), hold);
  }
  hideAgents() {
    this.agents.classList.remove("on");
    this.core.setNodes((this.core.nodes || []).map((n) => ({ ...n, s: 0 })));
    setTimeout(() => { if (!this.agents.classList.contains("on")) { this.agents.innerHTML = ""; this.agents.hidden = true; this.agentList = []; } }, 500);
  }

  _placeNodes(fresh) {
    const list = this.agentList || []; if (!list.length) return;
    const c = this.coreBox(), n = list.length;
    let pts;
    if (this.mode === "rest" || wide()) {
      /* an arc above the Core */
      const R = c.r * 2.1 + 34, a0 = -160, a1 = -20;
      pts = list.map((_, i) => { const a = (n === 1 ? -90 : a0 + (a1 - a0) * i / (n - 1)) * Math.PI / 180; return { x: c.x + Math.cos(a) * R, y: c.y + Math.sin(a) * R }; });
    } else {
      /* either side of the risen Core */
      const gap = Math.min(96, (innerWidth / 2 - c.r * 1.4 - 24) / Math.ceil(n / 2));
      pts = list.map((_, i) => { const side = i % 2 ? 1 : -1, k = Math.floor(i / 2); return { x: c.x + side * (c.r * 1.6 + 40 + k * gap), y: c.y - 8 + k * 46 }; });
    }
    Array.from(this.agents.children).forEach((el, i) => { el.style.left = pts[i].x + "px"; el.style.top = pts[i].y + "px"; });
    this.core.setNodes(pts.map((p, i) => ({ x: p.x, y: p.y, s: list[i].state === "not_connected" ? 0.25 : 1 })));
    if (fresh && this.reduced) this.agents.classList.add("on");
  }
}
