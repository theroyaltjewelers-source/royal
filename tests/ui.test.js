/* The interface pass: plain words when something fails, the HUD layer, and
   panels that behave.  Structural checks where a browser would be needed,
   behaviour checks where the code is pure. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { providerProblem, providerLine, providerNotice, serverProblem } from "../web/js/notices.js";
import { GrokProvider } from "../core/providers/grok.js";
import { createRoyal } from "../core/royal.js";
import { MemoryStore } from "../core/store.js";
import { house } from "./fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const OUT_OF_CREDITS = "Your team has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit.";
const xai = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("provider failures are named in plain words, with the fix", () => {
  const credits = providerProblem({ failed_because: "PROVIDER_HTTP_429", detail: OUT_OF_CREDITS });
  assert.equal(credits.kind, "credits"); assert.match(credits.why, /out of credits/); assert.match(credits.fix, /console\.x\.ai/);
  assert.equal(providerProblem({ failed_because: "PROVIDER_HTTP_403", detail: "used all available credits" }).kind, "credits");
  assert.equal(providerProblem({ failed_because: "PROVIDER_HTTP_402" }).kind, "credits");
  assert.equal(providerProblem({ failed_because: "PROVIDER_HTTP_401" }).kind, "key");
  assert.equal(providerProblem({ failed_because: "PROVIDER_HTTP_429", detail: "slow down" }).kind, "busy");
  assert.equal(providerProblem({ failed_because: "PROVIDER_HTTP_503" }).kind, "outage");
  assert.equal(providerProblem({ failed_because: "PROVIDER_TIMEOUT" }).kind, "slow");
  assert.equal(providerProblem({ failed_because: "PROVIDER_NOT_CONNECTED" }).kind, "not_set_up");
  assert.equal(providerProblem({ failed_because: "CANNOT_EVALUATE" }), null, "not a provider failure");
  /* from a provider status, as /v1/status reports it */
  assert.equal(providerProblem({ status: "CONNECTED", model: "grok-4" }), null);
  assert.equal(providerProblem({ status: "NOT_CONNECTED", detail: "XAI_API_KEY is not set on the server." }).kind, "not_set_up");
  assert.equal(providerProblem({ status: "DEGRADED", detail: "Last call failed: HTTP 429: " + OUT_OF_CREDITS }).kind, "credits");
  assert.equal(providerProblem({ status: "DEGRADED", detail: "Last call failed: timeout" }).kind, "slow");
  const n = providerNotice({ status: "DEGRADED", detail: "Last call failed: HTTP 429: " + OUT_OF_CREDITS });
  assert.equal(n.title, "AI brain offline"); assert.equal(n.tone, "attention"); assert.match(n.text, /out of credits/);
  assert.ok(!/Your team/.test(n.text + providerLine({ failed_because: "PROVIDER_HTTP_429", detail: OUT_OF_CREDITS })), "the provider's own text is classified, never echoed");
  assert.equal(providerNotice({ status: "CONNECTED" }), null);
});

test("an out-of-credits provider gives an answer that says so, and still invents nothing", async () => {
  const provider = new GrokProvider({ apiKey: "test-key", model: "grok-test", fetchImpl: xai(429, { error: OUT_OF_CREDITS }) });
  const r = createRoyal({ store: new MemoryStore(), provider });
  await r.ingestCalculator(house());
  const a = await r.handle({ content: "Should I raise prices on grillz?", conversation_id: "c1" });
  assert.equal(a.status, "FAILED");
  assert.match(a.summary, /AI brain \(xAI Grok\) didn't answer: the xAI account is out of credits/);
  assert.match(a.summary, /No answer was made up/);
  assert.ok(!/PROVIDER_HTTP_/.test(a.summary), "no raw error code in the sentence");
  const n = providerNotice(provider.status());
  assert.ok(n && /out of credits/.test(n.text), "the status the page reads leads to the same banner");
});

test("server trouble is described, never as 'something unreadable'", () => {
  assert.match(serverProblem({ status: 502 }), /restarting or overloaded \(error 502\)/);
  assert.match(serverProblem({ status: 500 }), /internal error \(error 500\)/);
  assert.match(serverProblem({ status: 404 }), /out of step/);
  assert.match(serverProblem({ network: true }), /couldn't be reached/);
  for (const m of [serverProblem({ status: 418 }), serverProblem({})]) assert.match(m, /Nothing was done/);
  const app = read("web/js/app.js");
  assert.ok(!/something unreadable/.test(app), "the old message is gone");
  assert.match(app, /serverProblem\(\{ status: r\.status \}\)/);
});

test("the page shows a dismissible notice for a down AI provider, and reads provider status on sign-in and after a failure", () => {
  const html = read("web/index.html"), app = read("web/js/app.js");
  assert.match(html, /<div id="notice" class="notice" role="status" hidden>/);
  assert.match(html, /id="noticeClose"[^>]*aria-label="Dismiss notice"/);
  assert.match(app, /checkBrain\(st\.provider\)/);
  assert.match(app, /res\.status === "FAILED" && \/AI brain\|PROVIDER_\/\.test/);
});

test("the bots panel says plainly when bot storage is temporary", () => {
  const bots = read("web/js/bots.js");
  assert.match(bots, /r\.storage === "TEMPORARY"/);
  assert.match(bots, /erased whenever it restarts or redeploys/);
  assert.match(read("web/css/royal.css"), /\.bp-warn \{/);
});

test("the HUD is decoration only: hidden from assistive tech, no pointer events, still under reduced motion", () => {
  const html = read("web/index.html"), css = read("web/css/royal.css");
  assert.match(html, /<div id="hud" class="hud" aria-hidden="true">/);
  assert.match(html, /id="modeInd" class="mode" aria-hidden="true"/);
  assert.match(css, /\.hud \{[^}]*pointer-events: none/);
  const reducedBlocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
  assert.match(reducedBlocks, /\.hud \.ring, \.mode i \{ animation: none !important; \}/, "infinite spins are stopped, not sped up, under reduced motion");
  /* the HUD moves only by transform and opacity */
  for (const m of css.matchAll(/@keyframes (hud-spin|mode-think) \{([^@]*?)\}\s*\}/g)) assert.ok(!/(left|top|width|height|margin)\s*:/.test(m[2]), m[1] + " animates layout");
  assert.ok(!/\sstyle="/.test(html), "still CSP-clean");
});

test("panels close the way they open, and the typing bar and menu cannot get stuck half-closed", () => {
  const app = read("web/js/app.js"), css = read("web/css/royal.css");
  assert.match(app, /function leave\(el\)[^\n]*if \(reduced\) \{ el\.hidden = true; return; \}/, "reduced motion closes at once");
  assert.match(app, /function openSheet\(view = "home"\) \{ unleave\(\$\("sheet"\)\)/);
  assert.match(app, /function openType\(\) \{ unleave\(\$\("typebar"\)\)/);
  assert.match(css, /\.sheet\.leaving \{/); assert.match(css, /\.typebar\.leaving \{/);
});
