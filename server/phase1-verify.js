/* The Phase 1 readiness gate: `npm run phase1:verify`.

   It decides PHASE 1 READY or PHASE 1 NOT READY from evidence, never from
   a list someone ticked:

     (a) the automated gates run the real test suite once and map each test,
         by name, to the gate it proves.  A gate passes only when every test
         mapped to it ran and passed; a skipped test is not a pass.
     (b) the durability gate needs the Postgres tests, so TEST_DATABASE_URL
         must point at a disposable database.
     (c) the production gates need the live server:
           ROYAL_URL=https://royal-1wx5.onrender.com ROYAL_TOKEN=<session token> npm run phase1:verify
         Without them those gates are NOT RUN, and NOT RUN is not READY.

   The token is the one the web app keeps after sign-in (localStorage
   "royal.session").  Nothing this prints contains it.  It sends no message
   to anyone and changes nothing: the live checks are reads, one spoken
   word ("Ready.") and one question to ROYAL. */

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* gate -> test names (regular expressions) that prove it. */
export const GATES = {
  IDENTITY: [/first person: no answer calls itself ROYAL in the third person/, /who ROYAL is: first person/],
  CONVERSATION: [/a project answer names the piece/, /follow-ups about the record under discussion stay with the House/, /TESTS A to E/],
  INTERNAL_DATA: [/ingest then ask, end to end/, /House records stay with the House: no model call/],
  KNOWLEDGE: [/each knowledge pack answers its benchmark questions/, /the reference is never used for House policy/],
  RESEARCH: [/TEST A: 'Who is the CFO of Acme\?' researches/, /current tax and law are never answered from the reference/, /prompt injection in research results is data/],
  AGENT: [/routing provenance/, /a native specialist run is an AgentTask too/],
  BOT: [/a bot is CONNECTED_VERIFIED only after a real round trip/, /the Bots panel decides Send from can_send/, /no code reads a bot's old status/],
  MULTI_AGENT: [/one specialist failing does not take the others down/, /stress: 20 mixed requests at once/, /a native run that times out is TIMED_OUT/],
  LEDGER: [/runs finishing at the same moment are all counted/, /“Tell me what each Bot did for work today\.” is answered from my records/, /\/v1\/agents reports current work from records/],
  EVENT: [/what happened today: payments, stage changes/, /what changed reports verified deltas and raises events once/],
  VOICE: [/barge-in: Tahir talks over ROYAL; she stops at once/, /activate once: question, answer, and ROYAL is listening again/, /thinking pauses stay inside one turn/,
    /background noise never opens or holds a turn/, /twenty turns in a row, hands free/, /never leaves her stuck/, /playback queue: chunks play back to back/],
  PERFORMANCE: [/greeting, who are you, thanks and House words: answered at once with no model call/, /a question the rules can't place costs one model call/],
  PERMISSION: [/sending a client message always requires approval/, /the realm wall: a business specialist cannot read the personal realm/, /the Personal side never sees business records/],
  VERIFICATION: [/a verification failure is caught even when the executor says ok/, /an approved action with no executor says a person must do it/, /email is verified only when the provider says delivered/],
  ERROR: [/every API call the page makes has a route that accepts its method/, /a known route asked with the wrong method is a 405/, /HEAD is answered like GET/],
  DURABILITY: [/postgres: a Decision survives a restart/, /postgres: boot reports MEMORY as DURABLE/, /Postgres: events, requests and tokens survive a restart/, /postgres: migrations apply once/],
  ROYAL_TO_BOT_FLOW: [/^ROYAL to ACE: /, /^ROYAL to GRACE: /, /^ROYAL to LEDGER: /, /^ROYAL to HOUSE: /, /^ROYAL to FORGE: /,
    /^GRACE and LEDGER together/, /lands in the same conversation's inbox/, /talk to each of the bots: my records first/, /a bot proposing to send an email gets nothing sent/,
    /a specialist may ask for another through ROYAL/, /connection test through the orchestrator/, /wording: I never say I asked a bot/, /^acceptance: “ROYAL\.” → each bot/],
  SECURITY: [/health is public and says nothing else/, /every other route needs a signed-in owner/, /never a token, body or query/, /prompt injection in research results is data/, /GET \/v1\/bots lists every bot with status and never a URL, key or header/],
};

function runTests() {
  return new Promise((ok) => {
    const files = readdirSync(join(ROOT, "tests")).filter((f) => f.endsWith(".test.js")).map((f) => join(ROOT, "tests", f));
    const p = spawn(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: ROOT, env: process.env });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", () => {});
    p.on("close", () => {
      const tests = [];
      for (const line of out.split("\n")) {
        const m = /^\s*(ok|not ok) \d+ - (.*?)(\s+# (SKIP|TODO).*)?$/.exec(line);
        if (m && !/^\s{4,}/.test(line)) tests.push({ name: m[2], pass: m[1] === "ok" && !m[3], skipped: !!m[3] });
      }
      ok(tests);
    });
  });
}

async function live() {
  const URL_ = (process.env.ROYAL_URL || "").replace(/\/$/, ""), TOKEN = process.env.ROYAL_TOKEN;
  if (!URL_ || !TOKEN) return null;
  const H = { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" };
  const get = async (p, init = {}) => { try { const r = await fetch(URL_ + p, { headers: H, ...init }); let j = null; try { j = await r.clone().json(); } catch (_) {} return { status: r.status, json: j, type: r.headers.get("content-type") || "" }; } catch (e) { return { status: 0, error: e.message }; } };
  const res = {};
  const health = await get("/v1/health"), head = await get("/", { method: "HEAD" });
  res.LIVE_HEALTH = { pass: health.status === 200 && head.status === 200, evidence: "GET /v1/health " + health.status + ", HEAD / " + head.status };
  const boot = await get("/v1/boot");
  const mem = boot.json && (boot.json.lines || []).find((l) => l.k === "MEMORY");
  res.LIVE_DURABILITY = { pass: !!(mem && mem.v === "DURABLE"), evidence: "boot MEMORY " + (mem ? mem.v : "unreadable (" + boot.status + ")") };
  const bots = await get("/v1/bots");
  const list = (bots.json && bots.json.bots) || [];
  const lying = list.filter((b) => b.connection_state === "CONNECTED_VERIFIED" && !b.last_verified_at);
  res.LIVE_BOT = { pass: bots.status === 200 && list.every((b) => "connection_state" in b && "can_send" in b) && !lying.length,
    evidence: list.map((b) => b.id + ": " + (b.connection_state || "?")).join(", ") || "no bots (" + bots.status + ")" };
  const team = await get("/v1/command", { method: "POST", body: JSON.stringify({ content: "Tell me what each Bot did for work today.", conversation_id: "phase1-verify" }) });
  const tr = team.json && team.json.result;
  res.LIVE_MULTI_AGENT = { pass: !!(tr && tr.skill === "agent_activity" && tr.status !== "FAILED"), evidence: tr ? tr.skill + " / " + tr.status : "HTTP " + team.status };
  const speak = await get("/v1/voice/speak?realm=BUSINESS", { method: "POST", body: JSON.stringify({ text: "Ready." }) });
  res.LIVE_VOICE = { pass: speak.status === 200 && /audio/.test(speak.type), evidence: "POST /v1/voice/speak " + speak.status + " " + speak.type };
  const calls = [["GET", "/v1/status"], ["GET", "/v1/boot"], ["GET", "/v1/agents"], ["GET", "/v1/activity?realm=BUSINESS"], ["GET", "/v1/decisions?status=OPEN&realm=BUSINESS"],
    ["GET", "/v1/intelligence/status"], ["GET", "/v1/bots?realm=BUSINESS"]];
  const bad = [];
  for (const [m, p] of calls) { const r = await get(p, { method: m }); if (r.status === 404 || r.status === 405 || r.status >= 500 || r.status === 0) bad.push(m + " " + p + " " + r.status); }
  res.LIVE_ERROR = { pass: !bad.length, evidence: bad.length ? bad.join("; ") : calls.length + " page routes answered without 404, 405 or 5xx" };

  /* ROYAL to each specialist's real Grok Bot, from the main conversation:
     a nonce connection test, then a question asked the way Tahir asks it,
     and the answer must come back to that conversation (at once, or in its
     inbox).  No Bots-panel message is sent. */
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const r2b = [];
  for (const id of ["ace", "grace", "ledger", "house", "forge"]) {
    const b = list.find((x) => x.id === id);
    if (!b || !b.can_send) { r2b.push(id + ": no Grok Bot configured"); continue; }
    const v = await get("/v1/bots/" + id + "/verify?realm=BUSINESS", { method: "POST", body: "{}" });
    let conn = null;
    for (let i = 0; i < 40 && v.status === 200; i++) {
      await sleep(3000);
      const l = await get("/v1/bots?realm=BUSINESS");
      conn = ((l.json && l.json.bots) || []).find((x) => x.id === id);
      if (conn && conn.connection_state === "CONNECTED_VERIFIED") break;
    }
    if (!conn || conn.connection_state !== "CONNECTED_VERIFIED") { r2b.push(id + ": connection test not answered (" + (conn ? conn.connection_state : "HTTP " + v.status) + ")"); continue; }
    const convo = "phase1-r2b-" + id + "-" + Date.now();
    const ask = await get("/v1/command", { method: "POST", body: JSON.stringify({ content: "Ask " + id.toUpperCase() + " what it worked on today.", conversation_id: convo }) });
    const res0 = ask.json && ask.json.result;
    let back = res0 && new RegExp("^" + id.toUpperCase() + " came back:").test(res0.summary || "");
    for (let i = 0; i < 40 && res0 && !back && res0.pending && res0.pending.length; i++) {
      await sleep(3000);
      const ib = await get("/v1/inbox?realm=BUSINESS&conversation_id=" + encodeURIComponent(convo));
      back = ((ib.json && ib.json.items) || []).some((it) => new RegExp("^" + id.toUpperCase() + " came back:").test((it.result && it.result.summary) || ""));
    }
    r2b.push(id + ": " + (back ? "verified, and its answer came back to the conversation" : "asked from the conversation, no answer came back (" + (res0 ? res0.summary.slice(0, 80) : "HTTP " + ask.status) + ")"));
  }
  res.LIVE_ROYAL_TO_BOT = { pass: r2b.every((x) => /came back to the conversation$/.test(x)), evidence: r2b.join("; ") };
  return res;
}

const tests = await runTests();
const rows = [];
for (const [gate, pats] of Object.entries(GATES)) {
  const matched = pats.map((re) => tests.filter((t) => re.test(t.name)));
  const missing = pats.filter((_, i) => !matched[i].length).map(String);
  const all = matched.flat();
  const failed = all.filter((t) => !t.pass && !t.skipped), skipped = all.filter((t) => t.skipped);
  const pass = !missing.length && !failed.length && !skipped.length;
  rows.push({ gate, pass, evidence: pass ? all.length + " tests passed" : [missing.length ? "no test found for " + missing.join(", ") : "", failed.length ? failed.length + " failed: " + failed.map((t) => t.name).join("; ") : "",
    skipped.length ? skipped.length + " skipped (" + (gate === "DURABILITY" ? "set TEST_DATABASE_URL" : "see the suite") + ")" : ""].filter(Boolean).join(" | ") });
}
const L = await live();
if (L) for (const [gate, r] of Object.entries(L)) rows.push({ gate, ...r });
else for (const gate of ["LIVE_HEALTH", "LIVE_DURABILITY", "LIVE_BOT", "LIVE_MULTI_AGENT", "LIVE_VOICE", "LIVE_ERROR", "LIVE_ROYAL_TO_BOT"]) rows.push({ gate, pass: false, evidence: "NOT RUN: set ROYAL_URL and ROYAL_TOKEN to check production" });

const total = tests.length, passed = tests.filter((t) => t.pass).length, skippedAll = tests.filter((t) => t.skipped).length;
console.log("\nROYAL Phase 1 readiness gate");
console.log("Suite: " + total + " tests, " + passed + " passed, " + (total - passed - skippedAll) + " failed, " + skippedAll + " skipped\n");
const w = Math.max(...rows.map((r) => r.gate.length));
for (const r of rows) console.log((r.pass ? "PASS " : "FAIL ") + r.gate.padEnd(w) + "  " + r.evidence);
const ready = rows.every((r) => r.pass);
console.log("\n" + (ready ? "PHASE 1 READY" : "PHASE 1 NOT READY: " + rows.filter((r) => !r.pass).map((r) => r.gate).join(", ")));
process.exit(ready ? 0 : 1);
