/* Phase 1 regression tests: the route contract, the bot state contract the
   page reads, and the defects this pass fixed.  Each test names the defect. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHandler, allowedMethods, routeOf } from "../server/handler.js";
import { createRoyal } from "../core/royal.js";
import { MemoryStore } from "../core/store.js";
import { canSendTo } from "../web/js/bots.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const USERS = { "t-owner": { id: "u-tahir", role: "owner" } };
function app(extra = {}) {
  const royal = createRoyal({ store: new MemoryStore() });
  const lines = [];
  const handler = createHandler({ royal, auth: async (t) => USERS[t] || null, log: (l) => lines.push(l), staticFiles: async (p) => (p === "/" ? new Response("<html>", { headers: { "Content-Type": "text/html" } }) : null), ...extra });
  const call = (method, path, { token = "t-owner", body } = {}) => handler(new Request("https://royal.test" + path, {
    method, headers: { ...(token ? { Authorization: "Bearer " + token } : {}), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }));
  return { royal, call, lines };
}

/* ------------------------------------------------------- route contract --- */

/* Every call the page makes, read from the page's own source.  The path
   argument is rebuilt with each concatenated expression standing for an id. */
function expand(src, start) {
  /* string pieces joined by +; any non-string piece is an id */
  let out = "", depth = 0, i = start, inExpr = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (!depth && c === '"') { const j = src.indexOf('"', i + 1); out += src.slice(i + 1, j); i = j; inExpr = false; continue; }
    if (c === "(") { depth++; continue; }
    if (c === ")") { if (!depth) break; depth--; continue; }
    if (!depth && c === ",") break;
    if (!depth && /[A-Za-z_]/.test(c) && !inExpr) { out += "ace"; inExpr = true; }
    if (!depth && c === "+") inExpr = false;
  }
  return out.split("?")[0];
}
async function frontendCalls() {
  const calls = [];
  const scan = (file, src, re, mIdx) => { for (const m of src.matchAll(re)) calls.push({ file, method: m[1] || "GET", path: expand(src, m.index + m[0].length) }); };
  for (const f of (await readdir(join(ROOT, "web", "js"))).filter((x) => x.endsWith(".js"))) {
    const src = await readFile(join(ROOT, "web", "js", f), "utf8");
    scan(f, src, /api\(\s*"(GET|POST|DELETE)",\s*/g);
    for (const m of src.matchAll(/fetch\(\(CFG\.API \|\| ""\) \+ /g)) {
      const tail = src.slice(m.index, m.index + 300), mm = /method: "(POST|DELETE)"/.exec(tail);
      if (src[m.index + m[0].length] !== '"') continue;   /* the api() wrapper itself */
      calls.push({ file: f, method: mm ? mm[1] : "GET", path: expand(src, m.index + m[0].length) });
    }
  }
  const embed = await readFile(join(ROOT, "web", "royal-embed.js"), "utf8");
  scan("royal-embed.js", embed, /call\("(GET|POST)",\s*/g);
  return calls;
}

test("every API call the page makes has a route that accepts its method (no 404 or 405 from normal use)", async () => {
  const calls = await frontendCalls();
  assert.ok(calls.length >= 20, "found the page's calls: " + calls.length);
  for (const c of calls) {
    const allow = allowedMethods(c.path);
    assert.ok(allow, c.file + ": " + c.method + " " + c.path + " has no route");
    assert.ok(allow.split(", ").indexOf(c.method) >= 0, c.file + ": " + c.method + " " + c.path + " is not accepted (" + allow + ")");
  }
});

test("a known route asked with the wrong method is a 405 with Allow, not a 404", async () => {
  const { call } = app();
  const g = await call("GET", "/v1/command");
  assert.equal(g.status, 405); assert.equal(g.headers.get("allow"), "POST");
  const v = await call("GET", "/v1/bots/ace/verify");
  assert.equal(v.status, 405);
  const t = await call("PUT", "/v1/bots/ace/token");
  assert.equal(t.status, 405); assert.equal(t.headers.get("allow"), "POST, DELETE");
  assert.equal((await call("GET", "/v1/no-such-thing")).status, 404, "an unknown route is still a 404");
  assert.equal((await call("POST", "/")).status, 405, "the page is GET only");
});

test("HEAD is answered like GET with no body (probes and link previews used to get 404)", async () => {
  const { call } = app();
  const h = await call("HEAD", "/v1/health", { token: null });
  assert.equal(h.status, 200); assert.equal(await h.text(), "");
  const p = await call("HEAD", "/", { token: null });
  assert.equal(p.status, 200); assert.equal(await p.text(), "");
});

test("each API request is logged once, folded, with its status and error code, and never a token, body or query", async () => {
  const { call, lines } = app();
  await call("POST", "/v1/command", { body: { content: "secret words about Marcus" } });
  await call("GET", "/v1/knowledge/search?q=" + encodeURIComponent("private question"));
  await call("GET", "/v1/bots/ace/requests/11111111-1111-4111-8111-111111111111");
  await call("GET", "/v1/status", { token: "forged-token-value" });
  await call("GET", "/v1/health", { token: null });
  const text = JSON.stringify(lines);
  for (const leak of ["secret words", "private question", "forged-token-value", "t-owner", "Marcus"]) assert.ok(!text.includes(leak), "logged " + leak);
  assert.ok(!lines.some((l) => l.route === "/v1/health"), "a passing health check is not logged");
  const unauth = lines.find((l) => l.status === 401);
  assert.equal(unauth.error, "AUTH_INVALID"); assert.equal(unauth.route, "/v1/status");
  assert.ok(lines.some((l) => l.route === "/v1/bots/:bot/requests/:uuid"));
  assert.ok(lines.every((l) => l.request_id && typeof l.ms === "number"));
  assert.equal(routeOf("/v1/decisions/dec_abc/resolve"), "/v1/decisions/:id/resolve");
});

test("liveness depends on nothing: health answers with no provider, store or bridge configured", async () => {
  const { call } = app();
  const r = await call("GET", "/v1/health", { token: null });
  assert.equal(r.status, 200); assert.equal((await r.json()).ok, true);
});

/* ------------------------------------------------------ bot state contract --- */

test("the Bots panel decides Send from can_send, never from a status string", () => {
  assert.equal(canSendTo({ can_send: true, connection_state: "CONFIGURED_UNVERIFIED" }), true, "a configured bot may be messaged (that is how it gets verified)");
  assert.equal(canSendTo({ status: "CONNECTED" }), false, "the old status field means nothing to the page");
  assert.equal(canSendTo({ can_send: false, connection_state: "NOT_CONFIGURED" }), false);
  assert.equal(canSendTo(null), false);
});

test("no code reads a bot's old status === \"CONNECTED\"", async () => {
  const files = ["web/js/bots.js", "core/intelligence/agents.js", "core/intelligence/index.js", "core/royal.js", "core/agent_ledger.js", "core/grokbot/bridge.js"];
  for (const f of files) {
    const src = await readFile(join(ROOT, f), "utf8");
    assert.ok(!/\b(bot|b|st)\.status === "CONNECTED"/.test(src), f);
  }
});
