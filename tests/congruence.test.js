/* Phone and desktop are one ROYAL: the same Core quality, the same speaking
   pulse, a Core large enough to see during an answer, specialists on screen,
   and the whole screen answering a touch.  The page's modules run against a
   stand-in browser. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/* A stand-in browser at a given size, with a store the test can read. */
function browser({ width, height, stored = {} }) {
  const mem = new Map(Object.entries(stored));
  const shims = {
    innerWidth: width, innerHeight: height,
    window: { devicePixelRatio: 3 },
    localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) },
    matchMedia: (q) => ({ matches: /max-width: 700px/.test(q) ? width <= 700 : false }),
    document: { hidden: false, addEventListener() {}, body: { dataset: {} } },
    addEventListener() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  };
  const saved = {};
  for (const [k, v] of Object.entries(shims)) { saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); }
  return { mem, restore: () => { for (const k of Object.keys(shims)) { if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k]; } } };
}
const canvas = () => ({ width: 0, height: 0, getContext: () => null, addEventListener() {} });
const fresh = (p) => import(p + "?v=" + Math.random());

test("the Core starts at the same quality on a phone as on a desktop", async () => {
  for (const [w, h] of [[390, 844], [360, 640], [1366, 768]]) {
    const b = browser({ width: w, height: h });
    try { const { RoyalCore } = await fresh("../web/js/core.js"); assert.equal(new RoyalCore(canvas()).tierName, "HIGH", w + "x" + h); }
    finally { b.restore(); }
  }
});

test("an old automatic step-down no longer keeps a phone on LOW; a tier chosen in the menu is kept", async () => {
  let b = browser({ width: 390, height: 844, stored: { "royal.quality": "LOW" } });
  try {
    const { RoyalCore } = await fresh("../web/js/core.js");
    assert.equal(new RoyalCore(canvas()).tierName, "HIGH");
    assert.equal(b.mem.has("royal.quality"), false, "the old key is cleared");
  } finally { b.restore(); }
  b = browser({ width: 390, height: 844, stored: { "royal.quality.chosen": "MEDIUM" } });
  try {
    const { RoyalCore } = await fresh("../web/js/core.js");
    const c = new RoyalCore(canvas());
    assert.equal(c.tierName, "MEDIUM");
    c.setTier("LOW"); assert.equal(b.mem.get("royal.quality.chosen"), "LOW", "a choice in the menu is remembered");
  } finally { b.restore(); }
});

test("a phone capped at 30 fps keeps its quality; a truly slow one steps down for this visit only", async () => {
  const b = browser({ width: 390, height: 844 });
  try {
    const { RoyalCore } = await fresh("../web/js/core.js");
    const c = new RoyalCore(canvas()); c.mode = "webgl";
    for (let i = 0; i < 200; i++) c._watch(1 / 30);
    assert.equal(c.tierName, "HIGH", "Low Power Mode's 30 fps is not struggling");
    for (let i = 0; i < 90; i++) c._watch(1 / 18);
    assert.equal(c.tierName, "MEDIUM");
    assert.equal(b.mem.has("royal.quality.chosen"), false, "an automatic step-down is not saved");
  } finally { b.restore(); }
});

test("speaking with a voice that reports no words still pulses visibly", async () => {
  const b = browser({ width: 390, height: 844 });
  try {
    const { RoyalCore } = await fresh("../web/js/core.js");
    const c = new RoyalCore(canvas());
    c.set({ energy: 1, scale: 1, speed: 0.4, coherence: 0.7, corona: 1 });
    c.setSpeaking(true);
    let peak = 0, low = 1;
    for (let i = 0; i < 180; i++) { c._ease(1 / 60); if (i > 30) { peak = Math.max(peak, c.amp); low = Math.min(low, c.amp); } }
    assert.ok(peak > 0.3, "peak " + peak.toFixed(2));
    assert.ok(peak - low > 0.1, "it rises and falls, not a flat glow");
  } finally { b.restore(); }
});

test("during an answer a phone keeps the Core large, and every specialist stays on screen", async () => {
  for (const [w, h] of [[360, 640], [390, 844]]) {
    const b = browser({ width: w, height: h });
    try {
      const { Stage } = await fresh("../web/js/stage.js");
      const nodes = [];
      const core = { nodes: [], setLayout() {}, setNodes: (n) => nodes.splice(0, nodes.length, ...n) };
      const el = () => ({ style: { setProperty() {} }, classList: { add() {}, remove() {}, contains: () => false, toggle() {} }, children: [] });
      const agents = el(); agents.children = Array.from({ length: 4 }, () => ({ style: {} }));
      const s = new Stage({ core, column: el(), objects: el(), caption: el(), heard: el(), agents, reduced: true });
      s.mode = "content";
      assert.ok(s.target().core.r >= 0.13, "risen Core radius " + s.target().core.r);
      s.agentList = [{ state: "reported" }, { state: "reported" }, { state: "reported" }, { state: "reported" }];
      s._placeNodes();
      for (const c of agents.children) { const x = parseFloat(c.style.left); assert.ok(x >= 48 && x <= w - 48, w + ": node at " + x); }
      assert.equal(nodes.length, 4);
    } finally { b.restore(); }
  }
});

test("the whole screen answers a touch: empty space in an answer wakes ROYAL, cards and controls keep their own taps", () => {
  const app = read("web/js/app.js");
  const m = /\$\("column"\)\.addEventListener\("click", \(e\) => \{([\s\S]*?)\n\}\);/.exec(app);
  assert.ok(m, "the answer column listens for taps");
  const body = m[1];
  assert.match(body, /layout !== "content"/, "only with an answer showing (at rest the column lets taps through)");
  assert.match(body, /closest\(OWN_TAP\)/);
  assert.match(app, /const OWN_TAP = "a, button, input, textarea, select, label, summary, details, \[role=button\], \[tabindex\], \.obj"/);
  assert.match(body, /getSelection/, "selecting text wakes nothing");
  assert.match(body, /wake\(e\)/);
  assert.match(body, /core\.touchAt\(e\.clientX, e\.clientY\)/, "the light answers where the finger landed");
});
