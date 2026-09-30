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
