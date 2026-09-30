/* The web client: structural checks that need no browser.  The page and its
   scripts must agree on every element, the page must work under the CSP
   (no inline script or style), and no secret may reach web/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const html = readFileSync(join(WEB, "index.html"), "utf8");
const files = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));

test("every element the app looks up exists in the page", () => {
  const app = readFileSync(join(WEB, "js", "app.js"), "utf8");
  const ids = new Set([...app.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]));
  const dynamic = new Set(["sbDec", "grokOut", "signOut", "testGrok", "replayBoot"]);   /* drawn inside the sheet */
  for (const id of ids) if (!dynamic.has(id)) assert.ok(html.includes('id="' + id + '"'), "index.html is missing #" + id);
});

test("the page works under the CSP: no inline script, style or handlers", () => {
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), "inline <script>");
  assert.ok(!/<style/.test(html), "inline <style>");
  assert.ok(!/\sstyle="/.test(html), "inline style attribute");
  assert.ok(!/\son[a-z]+="/.test(html), "inline event handler");
  for (const f of files(join(WEB, "js"))) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/style="/.test(src), f + " writes an inline style attribute, which the CSP blocks");
  }
});

test("every local file the page loads exists", () => {
  for (const m of html.matchAll(/(?:src|href)="(?!https?:|data:|#)([^"]+)"/g)) assert.ok(existsSync(join(WEB, m[1])), m[1] + " is missing");
});

test("no secret reaches web/", () => {
  for (const f of files(WEB)) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/xai-[A-Za-z0-9]{20,}/.test(src), f + " contains an xAI key");
    assert.ok(!/service_role/.test(src), f + " mentions a service-role key");
    assert.ok(!/ROYAL_SESSION_SECRET\s*[:=]\s*["'][^"']/.test(src), f + " contains the session secret");
  }
});

test("the composer shows one node per specialist, however many times it reported", async () => {
  const { compose } = await import("../core/composer.js");
  const spec = compose({ status: "OK", summary: "x", surface: { type: "text" }, delegations: [{ agent: "grace", verified: true }, { agent: "ledger", verified: true }, { agent: "grace", verified: true }] });
  assert.deepEqual(spec.spec ? spec.spec.agents.map((a) => a.id) : spec.agents.map((a) => a.id), ["grace", "ledger"]);
});

test("the page never sets a body attribute that action handlers look for", () => {
  /* A body data-sheet attribute once made every menu tap resolve to the body
     (closest("[data-sheet]")), so Business/Personal switching silently failed.
     Handlers inside the menu are scoped to #sheetBody for the same reason. */
  const app = readFileSync(join(WEB, "js", "app.js"), "utf8");
  const bodyKeys = [...app.matchAll(/document\.body\.dataset\.([a-zA-Z]+)\s*=/g)].map((m) => m[1]);
  const actionKeys = [...app.matchAll(/closest\("\[data-([a-z-]+)\]"\)/g)].map((m) => m[1].replace(/-(\w)/g, (_, c) => c.toUpperCase()));
  for (const k of bodyKeys) assert.ok(actionKeys.indexOf(k) < 0, "body data-" + k + " collides with an action handler");
});

test("bot markdown is rendered safely: no raw HTML, no script links, only a fixed set of tags", async () => {
  const { renderMarkdown } = await import("../web/js/markdown.js");
  const evil = [
    "<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "[click](javascript:alert(1))", "[x](data:text/html,<b>)",
    "<a href=\"https://x\" onclick=\"y\">z</a>", "**<svg onload=alert(1)>**", "```\n<script>bad()</script>\n```", "[ok](https://ok.example/\" onmouseover=\"x)",
  ].join("\n\n");
  const html = renderMarkdown(evil);
  assert.ok(!/<(script|img|svg|iframe|a href="javascript|a href="data)/i.test(html), html);
  assert.ok(!/<[^>]+\son[a-z]+=/i.test(html), "no event-handler attribute inside any tag: " + html);
  const tags = [...html.matchAll(/<([a-z0-9]+)/g)].map((m) => m[1]);
  const allowed = ["p", "br", "h3", "h4", "h5", "h6", "strong", "em", "code", "pre", "ul", "ol", "li", "blockquote", "hr", "a"];
  assert.ok(tags.every((t) => allowed.includes(t)), "unexpected tag in " + tags.join(","));
  const good = renderMarkdown("# Briefing\n\n**Two** things:\n- one `x`\n- two\n\n[Open](https://example.com/a?b=1&c=2)");
  assert.match(good, /<h3>Briefing<\/h3>/); assert.match(good, /<strong>Two<\/strong>/); assert.match(good, /<ul><li>one <code>x<\/code><\/li><li>two<\/li><\/ul>/);
  assert.match(good, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">Open<\/a>/);
});

test("pressing the Core: the light answers on pointerdown, a long press opens no menu, and the action stays on click", () => {
  const app = readFileSync(join(WEB, "js", "app.js"), "utf8");
  const css = readFileSync(join(WEB, "css", "royal.css"), "utf8");
  assert.match(app, /addEventListener\("pointerdown", pressStart/, "the Core gives feedback the moment it is pressed");
  assert.match(app, /addEventListener\("contextmenu", noHoldMenu\)/, "a long press on a phone opens no context menu over the Core");
  assert.match(app, /\$\("wake"\)\.addEventListener\("click", wake\)/, "what a press does still runs on click (keyboard and user-gesture rules)");
  assert.match(css, /#core, \.wake \{[^}]*user-select: none[^}]*-webkit-touch-callout: none/, "holding the Core selects no text");
});

test("the Core keeps real time at rest: time is measured from the last frame drawn, not from skipped frames", () => {
  const core = readFileSync(join(WEB, "js", "core.js"), "utf8");
  const loop = core.slice(core.indexOf("_loop() {"), core.indexOf("_ease(dt) {"));
  assert.ok(loop.indexOf("const dt") > loop.indexOf("< 32) { requestAnimationFrame(step); return; }"), "dt must be computed after the 30 fps skip, or the Core runs slow at rest and lurches when touched");
  assert.match(loop, /if \(!atRest\) this\._watch\(dt\)/, "30 fps at rest must not count as a slow device");
  assert.match(core, /pulse\(a = 0\.7\) \{ this\.ampTarget = /, "a pulse eases in; it does not jump the light");
});

test("a second touch while the microphone is starting does not start a second recognizer", async () => {
  let starts = 0, aborts = 0;
  class FakeSR { start() { starts++; } abort() { aborts++; if (this.onend) this.onend(); } stop() { if (this.onend) this.onend(); } }
  const saved = { window: globalThis.window, localStorage: globalThis.localStorage };
  /* browser globals voice.js touches, added only where Node lacks them */
  const shims = { navigator: { language: "en-US" }, cancelAnimationFrame: () => {} };
  const added = Object.keys(shims).filter((k) => !(k in globalThis));
  for (const k of added) Object.defineProperty(globalThis, k, { value: shims[k], configurable: true });
  globalThis.window = { SpeechRecognition: FakeSR };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  try {
    const { Voice } = await import("../web/js/voice.js?press=" + Date.now());
    const v = new Voice({});
    assert.equal(await v.listen(), true);
    assert.equal(await v.listen(), true);
    assert.equal(starts, 1, "only one recognizer is started while the first is still starting");
    v.cancel();
    assert.equal(aborts, 1, "cancelling while starting stops the pending recognizer");
    assert.equal(await v.listen(), true);
    assert.equal(starts, 2, "after a cancel, the next touch starts listening again");
    v.cancel();
  } finally {
    globalThis.window = saved.window; globalThis.localStorage = saved.localStorage;
    for (const k of added) delete globalThis[k];
  }
});

/* ------------------------------------------------ the Core feels alive --- */
/* Browser globals the Core and Sound touch, added only where Node lacks them
   and removed afterwards. */
async function withBrowser(extra, fn) {
  const shims = { matchMedia: () => ({ matches: false }), document: { addEventListener() {}, hidden: false }, localStorage: { getItem: () => null, setItem() {} }, requestAnimationFrame: () => 0, ...extra };
  const saved = {}, added = [];
  for (const [k, v] of Object.entries(shims)) {
    if (k in globalThis) { saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); }
    else added.push(k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  try { return await fn(); }
  finally {
    for (const k of added) delete globalThis[k];
    for (const [k, d] of Object.entries(saved)) Object.defineProperty(globalThis, k, d);
  }
}
const noCanvas = { getContext: () => null, addEventListener() {} };
const frames = (core, seconds, each) => { for (let t = 0; t < seconds; t += 1 / 60) { core._ease(1 / 60); if (each) each(core); } };

test("idle breathing is irregular: organic() stays in range and does not repeat like a plain sine", async () => {
  const { organic } = await import("../web/js/core.js");
  const P = 2 * Math.PI / 0.83;
  let maxAbs = 0, diff = 0;
  for (let t = 0; t < 120; t += 0.1) { maxAbs = Math.max(maxAbs, Math.abs(organic(t))); diff = Math.max(diff, Math.abs(organic(t) - organic(t + P))); }
  assert.ok(maxAbs <= 1 && maxAbs > 0.6, "bounded to [-1, 1] and actually moving");
  assert.ok(diff > 0.2, "one period of the main wave later, the rhythm is different");
});

test("a press squeezes softly and the release springs back with a slight overshoot, then settles", async () => {
  await withBrowser({}, async () => {
    const { RoyalCore } = await import("../web/js/core.js?alive=1");
    const { STATES } = await import("../web/js/state.js");
    const core = new RoyalCore(noCanvas); core.set(STATES.AMBIENT);
    core.press(true); let over = 0; frames(core, 0.12, (c) => { over = Math.max(over, c.pressX); });
    assert.ok(core.pressX > 0.8, "the squeeze arrives within about a tenth of a second");
    assert.ok(over < 1.05, "and does not bounce going in");
    core.press(false); let min = 0; frames(core, 2, (c) => { min = Math.min(min, c.pressX); });
    assert.ok(min < -0.1 && min > -0.4, "the release overshoots a little (" + min.toFixed(3) + ")");
    assert.ok(Math.abs(core.pressX) < 0.01 && !core.moving, "and comes to rest");
  });
});

test("reduced motion: a press still glows, with no spring and no overshoot", async () => {
  await withBrowser({}, async () => {
    const { RoyalCore } = await import("../web/js/core.js?alive=2");
    const { STATES } = await import("../web/js/state.js");
    const core = new RoyalCore(noCanvas, { reducedMotion: true }); core.set(STATES.AMBIENT);
    core.press(true); frames(core, 0.3); assert.ok(core.pressX > 0.9);
    core.press(false); let min = 1; frames(core, 1.5, (c) => { min = Math.min(min, c.pressX); });
    assert.ok(min >= 0, "never below rest");
  });
});

test("state changes glide: they start gently, never overshoot, and arrive; THINKING has its own motion", async () => {
  await withBrowser({}, async () => {
    const { RoyalCore } = await import("../web/js/core.js?alive=3");
    const { STATES } = await import("../web/js/state.js");
    const core = new RoyalCore(noCanvas); core.set(STATES.AMBIENT); core.set(STATES.THINKING);
    const from = STATES.AMBIENT.energy, to = STATES.THINKING.energy;
    core._ease(1 / 60);
    const first = (core.cur.energy - from) / (to - from);
    assert.ok(first < 0.01, "the first frame moves less than 1% of the way (an eased start, not a snap)");
    let peak = 0; frames(core, 2.5, (c) => { peak = Math.max(peak, c.cur.energy); });
    assert.ok(peak <= to + 1e-6, "no overshoot");
    assert.ok(Math.abs(core.cur.energy - to) < 0.01, "arrives within about two seconds");
    assert.ok(core.cur.think > 0.98, "THINKING carries its own sweep, distinct from idle");
    for (const [name, s] of Object.entries(STATES)) if (name !== "THINKING") assert.equal(s.think, 0, name + " has no thinking sweep");
  });
});

test("the Core follows ROYAL's voice: speaking with no level lifts it; stopping lets it settle", async () => {
  await withBrowser({}, async () => {
    const { RoyalCore } = await import("../web/js/core.js?alive=4");
    const { STATES } = await import("../web/js/state.js");
    const core = new RoyalCore(noCanvas); core.set(STATES.RESPONDING);
    core.setSpeaking(true); frames(core, 1); assert.ok(core.amp > 0.03, "speaking moves the Core");
    core.setSpeaking(false); frames(core, 3); assert.ok(core.amp < 0.01, "silence lets it rest");
    core.setAmplitude(0.8); frames(core, 0.1); assert.ok(core.amp > 0.3, "a microphone level is followed within a tenth of a second");
  });
});

test("a press taps the phone gently: very short, never under reduced motion, never before the page was touched, no double knock", async () => {
  const calls = [];
  const nav = { vibrate: (p) => { calls.push(p); return true; }, userActivation: { hasBeenActive: true } };
  await withBrowser({ navigator: nav }, async () => {
    const { Sound } = await import("../web/js/sound.js?alive=1");
    const s = new Sound();
    assert.equal(s.tap(), true); assert.deepEqual(calls, [6]);
    s.play("wake"); assert.deepEqual(calls, [6], "the wake buzz right after the tap is skipped");
    nav.userActivation.hasBeenActive = false; assert.equal(s.tap(), false, "not before the page was touched");
    nav.userActivation.hasBeenActive = true;
    globalThis.matchMedia = () => ({ matches: true });
    assert.equal(new Sound().tap(), false, "not under reduced motion");
  });
});

test("the page wires the alive Core: press and release, the voice's speaking state", () => {
  const app = readFileSync(join(WEB, "js", "app.js"), "utf8");
  assert.match(app, /core\.press\(true\)/); assert.match(app, /\["pointerup", "pointercancel", "blur"\]\.forEach/);
  assert.match(app, /onSpeaking: \(on\) => /); assert.match(app, /sound\.tap\(\)/);
});
