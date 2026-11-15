import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { MemoryStore } from "../core/store.js";
import { createRoyal } from "../core/royal.js";
import { createHandler } from "../server/handler.js";
import {
  EMPTY_BODY_SHA256, canonicalString, chunkAck, contentSha256, createFeedClient, feedHeaders, signFeed,
} from "../core/odoo/feed.js";
import { createOdooClient, retryWaitMs } from "../core/odoo/client.js";
import { planEvent, recordKey } from "../core/odoo/plan.js";
import { applyHouseEvent, inquiryMarker, leadTitle, memoHasTag, partnerRef, taggedMemo } from "../core/odoo/map.js";
import { ODOO_STORE, createSync, odooSyncFromEnv, readOdooConfig, runPass, storeId } from "../core/odoo/sync.js";

const SECRET = "test-secret-key-test-secret-key-test";
const WHEN = "2026-11-15T20:05:00Z";
const NONCE = "9f2c1a7e4b6d8e0f3a5c7b9d";
const TARGET = "/api/odoo-bridge/v1/events?after=0&limit=50";
const GET_SIG = "a678de3e68009b0313afdd28242c392ffabf5bc49837b1e0ef0dba400092c644";
const ACK_BODY = "{\"delivered\":[\"evt_1\"],\"failed\":[{\"event_id\":\"evt_2\",\"error\":\"nope\"}]}";
const ACK_HASH = "6c01a2872b22b68c27ddf5286bd84de88ce91a0ba16c39818669afdd4f5086c8";
const ACK_SIG = "0c2285315048e007e3e5a09393c446acdb958b5c7a7c53a976e6c79b81769a39";

function env(extra = {}) {
  return {
    client_id: "rec_client", first_name: "Jordan", last_name: "Reyes", name: "Jordan Reyes",
    email: "jordan@example.com", phone: "+1 555 0100", instagram: "@jreyes",
    address: "12 Main St, Charlotte, NC", source: "Instagram", archived: false, test: false,
    dashboard_link: "https://dash.example/clients/rec_client", ...extra,
  };
}
function inquiry(extra = {}) {
  return {
    inquiry_id: "rec_inq", client_id: "rec_client", customer_name: "Jordan Reyes", first_name: "Jordan", last_name: "Reyes",
    email: "jordan@example.com", phone: "+1 555 0100", location: { city: "Charlotte", region: "NC", country: "US", text: "Charlotte, NC, US" },
    piece_type: "Pendant", piece_name: "Custom Crown Pendant", metal: "14k Yellow Gold", stones: "VVS Moissanite",
    budget: "$3,000-$5,000", message: "Looking for a crown.", status: "new", kind: "product",
    dashboard_link: "https://dash.example/inquiries/rec_inq", test: false, ...extra,
  };
}
function payment(extra = {}) {
  return {
    payment_id: "rec_pay", client_id: "rec_client", client_name: "Jordan Reyes", email: "jordan@example.com",
    phone: "+1 555 0100", amount: "850.00", currency: "USD", date: "2026-11-15", memo: "#1042 - Crown Pendant",
    reference: "#1042", description: "Crown Pendant", status: "posted", test: false, ...extra,
  };
}
function envelope(event_type, data, extra = {}) {
  return { event_id: extra.event_id || "evt_" + event_type.replace(/\W/g, "_"), event_type, occurred_at: WHEN,
    record_version: extra.record_version == null ? 1 : extra.record_version, test: !!extra.test, resend: false,
    source: "the-house-of-royal-t", data };
}

/* A stand-in Odoo. Records the JSON-2 operations the mapper asks for and
   applies the few state changes those methods make, so a second pass can see
   won / posted / cancelled without a network. */
function fakeOdoo() {
  const calls = [];
  const db = {
    "res.partner": [], "crm.lead": [], "account.payment": [],
    "account.journal": [{ id: 7, name: "Bank", type: "bank", sequence: 1, inbound_payment_method_line_ids: [3], outbound_payment_method_line_ids: [4] }],
    "res.currency": [{ id: 1, name: "USD" }],
    "crm.stage": [{ id: 2, name: "New", is_won: false, sequence: 1 }, { id: 9, name: "Won", is_won: true, sequence: 10 }],
  };
  let seq = 100;
  let failCreates = 0;
  const rows = (model) => db[model] || (db[model] = []);
  function visible(row, context) {
    if (row.active === false && !(context && context.active_test === false)) return false;
    return true;
  }
  function match(row, domain) {
    return (domain || []).every(([field, op, value]) => {
      const cur = row[field];
      const a = cur == null ? "" : String(cur);
      const b = value == null ? "" : String(value);
      if (op === "=") return cur === value || a === b;
      if (op === "=ilike") return a.toLowerCase() === b.toLowerCase();
      if (op === "ilike") return a.toLowerCase().includes(b.toLowerCase());
      throw new Error("unexpected domain op " + op);
    });
  }
  function project(row, fields) {
    const out = { id: row.id };
    for (const f of fields || []) out[f] = row[f];
    return out;
  }
  return {
    calls, db,
    failCreates(n) { failCreates = n; },
    async searchRead(model, spec) {
      calls.push({ op: "search_read", model, domain: spec.domain });
      return rows(model).filter((r) => visible(r, spec.context) && match(r, spec.domain)).slice(0, spec.limit || 50).map((r) => project(r, spec.fields));
    },
    async read(model, ids, fields) {
      calls.push({ op: "read", model, ids });
      return rows(model).filter((r) => ids.includes(r.id)).map((r) => project(r, fields));
    },
    async create(model, vals) {
      if (failCreates > 0) { failCreates--; throw new Error("Odoo refused " + model + ".create: down"); }
      const row = { id: ++seq, active: true, ...vals };
      if (model === "crm.lead") { row.won_status = "pending"; row.probability = 10; }
      if (model === "account.payment") row.state = "draft";
      rows(model).push(row);
      calls.push({ op: "create", model, vals });
      return row.id;
    },
    async write(model, ids, vals) {
      calls.push({ op: "write", model, ids, vals });
      for (const row of rows(model)) if (ids.includes(row.id)) Object.assign(row, vals);
      return true;
    },
    async exec(model, method, ids) {
      calls.push({ op: method, model, ids });
      for (const row of rows(model)) {
        if (!ids.includes(row.id)) continue;
        if (method === "action_set_won") Object.assign(row, { won_status: "won", probability: 100, active: true, stage_id: 9 });
        if (method === "action_set_lost") Object.assign(row, { won_status: "lost", probability: 0, active: false });
        if (method === "action_restore") Object.assign(row, { won_status: "pending", probability: 10, active: true });
        if (method === "action_post") row.state = "in_process";
        if (method === "action_draft") {
          if (row.reconciled) throw new Error("You cannot reset a reconciled payment to draft.");
          row.state = "draft";
        }
        if (method === "action_cancel") row.state = "canceled";
      }
      return true;
    },
  };
}

function scriptedFeed(pages) {
  const acks = [];
  const gets = [];
  let i = 0;
  return {
    acks, gets,
    async getEvents(after, limit) { gets.push({ after, limit }); return pages[i++] || { ok: true, events: [], has_more: false }; },
    async ack(body) { acks.push(body); return { ok: true, delivered: body.delivered.length, failed: body.failed.length }; },
  };
}

const quiet = { allowTest: false, journalId: null, secrets: [] };

test("HMAC canonical string: empty GET body, exact query, secret used as UTF-8", () => {
  assert.equal(contentSha256(""), EMPTY_BODY_SHA256);
  assert.equal(EMPTY_BODY_SHA256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const signed = signFeed({ secret: SECRET, method: "GET", target: TARGET, timestamp: WHEN, nonce: NONCE, body: "" });
  assert.equal(signed.contentSha256, EMPTY_BODY_SHA256);
  assert.equal(signed.canonical.endsWith("\n"), false);
  assert.equal(signed.canonical.split("\n").length, 6);
  assert.equal(signed.canonical, ["RT-ODOO-FEED/1", "GET", TARGET, WHEN, NONCE, EMPTY_BODY_SHA256].join("\n"));
  assert.equal(signed.signature, GET_SIG);
  const other = signFeed({ secret: SECRET, method: "GET", target: TARGET.replace("after=0", "after=1"), timestamp: WHEN, nonce: NONCE, body: "" });
  assert.notEqual(other.signature, signed.signature, "the query is signed byte for byte");
  const post = signFeed({ secret: SECRET, method: "POST", target: "/api/odoo-bridge/v1/ack", timestamp: WHEN, nonce: NONCE, body: ACK_BODY });
  assert.equal(post.contentSha256, ACK_HASH);
  assert.equal(post.signature, ACK_SIG);
  assert.equal(contentSha256(ACK_BODY), createHash("sha256").update(ACK_BODY).digest("hex"));
  const asText = signFeed({ secret: "aa", method: "GET", target: TARGET, timestamp: WHEN, nonce: NONCE, body: "" });
  const direct = createHmac("sha256", "aa").update(asText.canonical).digest("hex");
  const decoded = createHmac("sha256", Buffer.from("aa", "hex")).update(asText.canonical).digest("hex");
  assert.equal(asText.signature, direct);
  assert.notEqual(asText.signature, decoded, "the secret is not hex-decoded");
  const headers = feedHeaders({ keyId: "odoo-1", secret: SECRET, method: "GET", target: TARGET, body: "", timestamp: WHEN, nonce: NONCE });
  assert.equal(headers.headers["X-RT-Signature"], GET_SIG);
  assert.equal(headers.headers["Content-Type"], undefined);
  assert.equal(canonicalString({ method: "get", target: TARGET, timestamp: WHEN, nonce: NONCE, contentSha256: EMPTY_BODY_SHA256 }).split("\n")[1], "GET");
});

test("the feed client signs the query it sends and acks with the raw body", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: init.method, headers: init.headers, body: init.body, redirect: init.redirect });
    if (String(url).includes("/events")) return new Response(JSON.stringify({ ok: true, mode: "testing", next_cursor: 4, has_more: false, events: [] }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, delivered: 1, failed: 0, ignored: [] }), { status: 200 });
  };
  const feed = createFeedClient({
    baseUrl: "https://thehouseofroyaltdesign.com/api/odoo-bridge/v1/", keyId: "odoo-1", secret: SECRET, fetchImpl,
    clock: () => new Date(WHEN), nonce: () => NONCE,
  });
  const page = await feed.getEvents(0, 50);
  assert.equal(page.has_more, false);
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].body, undefined);
  assert.equal(seen[0].redirect, "error");
  assert.equal(seen[0].url, "https://thehouseofroyaltdesign.com" + TARGET);
  assert.equal(seen[0].headers["X-RT-Content-SHA256"], EMPTY_BODY_SHA256);
  assert.equal(seen[0].headers["X-RT-Signature"], GET_SIG);
  assert.equal(seen[0].headers["X-RT-Key-Id"], "odoo-1");
  assert.equal(seen[0].headers["X-RT-Timestamp"], WHEN);
  await feed.ack({ delivered: ["evt_1"], failed: [{ event_id: "evt_2", error: "nope" }] });
  assert.equal(seen[1].method, "POST");
  assert.equal(seen[1].body, ACK_BODY);
  assert.equal(seen[1].headers["X-RT-Content-SHA256"], ACK_HASH);
  assert.equal(seen[1].headers["X-RT-Signature"], ACK_SIG);
  assert.equal(seen[1].headers["Content-Type"], "application/json");
  assert.equal(chunkAck(["a", "b"], [{ event_id: "c", error: "e" }], 1).length, 2);
});

test("a 429 is retried after Retry-After, and a 503 backs off", async () => {
  assert.equal(retryWaitMs(0, "3", 0), 3000);
  assert.equal(retryWaitMs(0, null, 0), 1000);
  assert.equal(retryWaitMs(2, null, 0), 4000);
  const waits = [];
  let hits = 0;
  const fetchImpl = async () => {
    hits++;
    if (hits === 1) return new Response("{}", { status: 429, headers: { "retry-after": "3" } });
    if (hits === 2) return new Response("{}", { status: 503 });
    return new Response(JSON.stringify([{ id: 1, name: "USD" }]), { status: 200 });
  };
  const odoo = createOdooClient({
    url: "https://the-house.example", database: "db", apiKey: "odoo-api-key-value-xxxx", fetchImpl,
    minIntervalMs: 0, sleep: async (ms) => { waits.push(ms); }, now: () => 1_000_000,
  });
  const rows = await odoo.searchRead("res.currency", { domain: [["name", "=", "USD"]], fields: ["name"], limit: 1 });
  assert.equal(rows[0].id, 1);
  assert.equal(hits, 3);
  assert.deepEqual(waits, [3000, 2000]);
  let again = 0;
  const failing = createOdooClient({
    url: "https://the-house.example", database: "db", apiKey: "odoo-api-key-value-xxxx",
    fetchImpl: async () => { again++; return new Response("{}", { status: 429, headers: { "retry-after": "0" } }); },
    minIntervalMs: 0, maxRetries: 2, sleep: async () => {},
  });
  await assert.rejects(() => failing.searchRead("res.partner", { domain: [], fields: ["id"], limit: 1 }), /HTTP 429/);
  assert.equal(again, 3, "the first try plus two retries");
});

test("Odoo JSON-2 calls use bearer, the database header, and named arguments", async () => {
  const apiKey = "odoo-api-key-value-xxxx";
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body), redirect: init.redirect });
    if (String(url).endsWith("/search_read")) return new Response(JSON.stringify([{ id: 5, name: "Ada" }]), { status: 200 });
    if (String(url).endsWith("/create")) return new Response("[44]", { status: 200, headers: { "content-type": "application/json" } });
    if (seen.length >= 4) return new Response(JSON.stringify({ name: "ValidationError", message: "bad " + apiKey, debug: "TRACE secret " + apiKey }), { status: 422 });
    return new Response("true", { status: 200 });
  };
  const odoo = createOdooClient({ url: "https://the-house.example/odoo", database: "the-house-of-royal-t-design1", apiKey, fetchImpl, minIntervalMs: 0 });
  const rows = await odoo.searchRead("res.partner", { domain: [["email", "=ilike", "a@b.c"]], fields: ["name"], limit: 1, context: { active_test: false } });
  assert.equal(rows[0].id, 5);
  assert.equal(seen[0].url, "https://the-house.example/json/2/res.partner/search_read");
  assert.equal(seen[0].redirect, "error");
  assert.equal(seen[0].headers.Authorization, "bearer " + apiKey);
  assert.equal(seen[0].headers["X-Odoo-Database"], "the-house-of-royal-t-design1");
  assert.equal(seen[0].headers["Content-Type"], "application/json; charset=utf-8");
  assert.deepEqual(Object.keys(seen[0].body).sort(), ["context", "domain", "fields", "limit"]);
  assert.equal(await odoo.create("crm.lead", { name: "Pendant - Ada" }), 44);
  assert.deepEqual(seen[1].body, { vals_list: [{ name: "Pendant - Ada" }] });
  await odoo.exec("account.payment", "action_post", [44]);
  assert.deepEqual(seen[2].body, { ids: [44] });
  await assert.rejects(() => odoo.call("account.payment", "action_post", {}), (e) => {
    assert.match(e.message, /\[redacted\]/);
    assert.equal(e.message.includes(apiKey), false);
    assert.equal(e.message.includes("TRACE"), false);
    return true;
  });
});

test("paging walks next_cursor from zero and acks each page before the next", async () => {
  const feed = scriptedFeed([
    { ok: true, events: [envelope("bridge.test", { message: "a" }, { event_id: "evt_a" })], has_more: true, next_cursor: 10 },
    { ok: true, events: [envelope("bridge.test", { message: "b" }, { event_id: "evt_b" })], has_more: false, next_cursor: 11 },
    { ok: true, events: [envelope("bridge.test", { message: "c" }, { event_id: "evt_c" })], has_more: false },
  ]);
  const odoo = fakeOdoo();
  const totals = await runPass({ feed, store: new MemoryStore(), cfg: quiet, odoo, limit: 50 });
  assert.deepEqual(feed.gets, [{ after: 0, limit: 50 }, { after: 10, limit: 50 }]);
  assert.equal(feed.acks.length, 2);
  assert.deepEqual(feed.acks[0].delivered, ["evt_a"]);
  assert.deepEqual(feed.acks[1].delivered, ["evt_b"]);
  assert.equal(totals.skipped, 2);
  assert.equal(totals.applied, 0);
  assert.equal(odoo.calls.length, 0, "bridge.test is never written to Odoo");
});

test("dedup, versions and the test flag", async () => {
  assert.equal(recordKey(envelope("client.created", env())), "client:rec_client");
  assert.equal(recordKey(envelope("payment.refunded", { refund_id: "gid://shopify/Refund/9", payment: {} })), "refund:gid://shopify/Refund/9");
  assert.equal(planEvent(envelope("bridge.test", { message: "hi" }, { event_id: "evt_b" })).reason, "bridge.test");
  assert.equal(planEvent(envelope("client.created", env(), { test: true }), { allowTest: false }).reason, "test");
  assert.equal(planEvent(envelope("client.created", { ...env(), test: true }), { allowTest: false }).reason, "test");
  assert.equal(planEvent(envelope("client.created", env(), { record_version: 3 }), { previousVersion: 4 }).reason, "stale-version");
  assert.equal(planEvent(envelope("client.created", env(), { record_version: 4 }), { previousVersion: 4 }).action, "apply");
  assert.equal(planEvent(envelope("nope.nope", {}), { allowTest: true }).action, "fail");

  const store = new MemoryStore();
  const odoo = fakeOdoo();
  const cfg = { ...quiet, secrets: [] };
  async function pass(events, { allowTest = false } = {}) {
    const feed = scriptedFeed([{ ok: true, events, has_more: false }]);
    const totals = await runPass({ feed, store, cfg: { ...cfg, allowTest }, odoo });
    return { feed, totals };
  }
  const created = envelope("client.created", env(), { event_id: "evt_c1", record_version: 5 });
  let r = await pass([created]);
  assert.equal(r.totals.applied, 1);
  assert.equal(odoo.db["res.partner"].length, 1);
  assert.deepEqual(r.feed.acks[0].delivered, ["evt_c1"]);

  r = await pass([created]);
  assert.equal(r.totals.applied, 0);
  assert.equal(r.totals.skipped, 1);
  assert.equal(odoo.db["res.partner"].length, 1, "the same event id is not applied twice");

  const stale = envelope("client.updated", env({ name: "Old Name" }), { event_id: "evt_old", record_version: 4 });
  r = await pass([stale]);
  assert.equal(r.totals.skipped, 1);
  assert.equal(odoo.db["res.partner"][0].name, "Jordan Reyes");
  assert.deepEqual(r.feed.acks[0].failed, []);

  const same = envelope("client.updated", env({ phone: "+1 555 0199" }), { event_id: "evt_same", record_version: 5 });
  r = await pass([same]);
  assert.equal(r.totals.applied, 1);
  assert.equal(odoo.db["res.partner"][0].phone, "+1 555 0199");

  const testEv = envelope("client.created", env({ client_id: "rec_test", email: "test@example.com", name: "Test Person", phone: "" }), { event_id: "evt_test", test: true, record_version: 1 });
  r = await pass([testEv]);
  assert.equal(r.totals.applied, 0);
  assert.equal(odoo.db["res.partner"].some((p) => p.email === "test@example.com"), false);
  assert.deepEqual(r.feed.acks[0].delivered, ["evt_test"]);

  r = await pass([envelope("client.created", env({ client_id: "rec_test2", email: "tested@example.com", name: "Allowed", phone: "+1 555 2222" }), { event_id: "evt_ok", test: true })], { allowTest: true });
  assert.equal(r.totals.applied, 1);
  assert.equal(odoo.db["res.partner"].some((p) => p.ref === "RT:rec_test2"), true);

  odoo.failCreates(1);
  const boom = envelope("client.created", env({ client_id: "rec_new", email: "new@example.com", name: "New", phone: "+1 555 3333" }), { event_id: "evt_boom" });
  r = await pass([boom]);
  assert.equal(r.totals.failed, 1);
  assert.equal(r.feed.acks.every((a) => (a.failed || []).length === 0), true, "a write failure is not acked, or the feed will not offer it again");
  const queued = await store.get(ODOO_STORE.retry, "evt_boom");
  assert.equal(queued.data.status, "pending");
  assert.equal(queued.data.event.event_id, "evt_boom");
  r = await pass([]);
  assert.equal(r.totals.applied, 1, "the saved event is retried on the next pass even when the feed is empty");
  assert.deepEqual(r.feed.acks[0].delivered, ["evt_boom"]);
  assert.equal((await store.get(ODOO_STORE.retry, "evt_boom")).data.status, "done");
});

test("clients, inquiries and payments map onto Odoo", async () => {
  const odoo = fakeOdoo();
  const cache = {};
  const cfg = { journalId: null };
  const partner = await applyHouseEvent(envelope("client.created", env()), { odoo, cache, cfg });
  assert.equal(partner.model, "res.partner");
  const row = odoo.db["res.partner"][0];
  assert.equal(row.ref, partnerRef("rec_client"));
  assert.equal(row.customer_rank, 1);
  assert.equal(row.email, "jordan@example.com");
  assert.equal(row.phone, "+1 555 0100");
  assert.equal(row.street, "12 Main St, Charlotte, NC");
  assert.match(row.comment, /@jreyes/);
  assert.match(row.comment, /Instagram/);
  assert.match(row.comment, /dash\.example\/clients/);
  assert.equal(odoo.calls.some((c) => c.op === "unlink"), false);

  const again = await applyHouseEvent(envelope("client.created", env({ client_id: "rec_other", name: "Jordan Reyes" })), { odoo, cache, cfg });
  assert.equal(again.odoo_id, partner.odoo_id, "an existing email is reused");
  assert.equal(odoo.db["res.partner"].length, 1);
  assert.equal(odoo.db["res.partner"][0].ref, "RT:rec_client", "a different House id does not steal a ref that is already set");

  await applyHouseEvent(envelope("client.updated", env({ archived: true, phone: "+1 555 0111" })), { odoo, cache, cfg, mappedId: partner.odoo_id });
  assert.equal(odoo.db["res.partner"][0].active, false);
  assert.equal(odoo.db["res.partner"][0].phone, "+1 555 0111");

  const lead = await applyHouseEvent(envelope("inquiry.created", inquiry()), { odoo, cache, cfg });
  assert.equal(lead.model, "crm.lead");
  const leadRow = odoo.db["crm.lead"][0];
  assert.equal(leadRow.name, leadTitle(inquiry()));
  assert.equal(leadRow.name, "Custom Crown Pendant - Jordan Reyes");
  assert.equal(leadRow.partner_id, partner.odoo_id);
  assert.equal(leadRow.contact_name, "Jordan Reyes");
  assert.equal(leadRow.email_from, "jordan@example.com");
  assert.match(leadRow.description, new RegExp(inquiryMarker("rec_inq").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(leadRow.description, /\$3,000-\$5,000/);
  assert.match(leadRow.description, /Looking for a crown/);
  assert.match(leadRow.description, /14k Yellow Gold/);
  assert.match(leadRow.description, /dash\.example\/inquiries/);
  assert.equal(odoo.calls.filter((c) => c.op === "action_set_won").length, 0);

  await applyHouseEvent(envelope("inquiry.updated", inquiry({ status: "converted" })), { odoo, cache, cfg, mappedId: lead.odoo_id });
  assert.equal(odoo.calls.filter((c) => c.op === "action_set_won").length, 1);
  await applyHouseEvent(envelope("inquiry.updated", inquiry({ status: "converted", message: "Still yes" })), { odoo, cache, cfg, mappedId: lead.odoo_id });
  assert.equal(odoo.calls.filter((c) => c.op === "action_set_won").length, 1, "won is not triggered again");

  await applyHouseEvent(envelope("inquiry.updated", inquiry({ status: "closed" })), { odoo, cache, cfg, mappedId: lead.odoo_id });
  assert.equal(odoo.calls.filter((c) => c.op === "action_set_lost").length, 1);
  await applyHouseEvent(envelope("inquiry.updated", inquiry({ status: "closed" })), { odoo, cache, cfg, mappedId: lead.odoo_id });
  assert.equal(odoo.calls.filter((c) => c.op === "action_set_lost").length, 1, "lost is not triggered again");

  await applyHouseEvent(envelope("inquiry.updated", inquiry({ status: "quoting" })), { odoo, cache, cfg, mappedId: lead.odoo_id });
  assert.equal(odoo.calls.filter((c) => c.op === "action_restore").length, 1);

  const pay = await applyHouseEvent(envelope("payment.recorded", payment()), { odoo, cache, cfg });
  const payRow = odoo.db["account.payment"].find((p) => p.id === pay.odoo_id);
  assert.equal(payRow.payment_type, "inbound");
  assert.equal(payRow.partner_type, "customer");
  assert.equal(payRow.amount, 850);
  assert.equal(payRow.date, "2026-11-15");
  assert.equal(payRow.journal_id, 7);
  assert.equal(payRow.payment_method_line_id, 3);
  assert.equal(memoHasTag(payRow.memo, "rec_pay"), true);
  assert.equal(payRow.memo.startsWith(taggedMemo("rec_pay", "").slice(0, 3)), true);
  assert.match(payRow.memo, /#1042/);
  assert.equal(payRow.state, "in_process");
  assert.equal(payRow.partner_id, partner.odoo_id);

  const posts = () => odoo.calls.filter((c) => c.op === "action_post").length;
  const before = posts();
  await applyHouseEvent(envelope("payment.updated", payment({ memo: "#1042 - updated" })), { odoo, cache, cfg, mappedId: pay.odoo_id });
  assert.equal(odoo.calls.filter((c) => c.op === "action_draft").length, 0, "an unchanged amount and date is not reset");
  assert.equal(posts(), before);

  await applyHouseEvent(envelope("payment.updated", payment({ amount: "900.00", date: "2026-11-16" })), { odoo, cache, cfg, mappedId: pay.odoo_id });
  const draftAt = odoo.calls.map((c) => c.op);
  const reset = draftAt.lastIndexOf("action_draft");
  assert.ok(reset > 0);
  assert.ok(draftAt.indexOf("action_post", reset) > reset);
  assert.equal(payRow.amount, 900);
  assert.equal(payRow.date, "2026-11-16");
  assert.equal(payRow.state, "in_process");

  payRow.reconciled = true;
  await assert.rejects(() => applyHouseEvent(envelope("payment.updated", payment({ amount: "1.00" })), { odoo, cache, cfg, mappedId: pay.odoo_id }), /reset this posted payment to draft/);
  assert.equal(payRow.amount, 900, "a failed reset leaves the posted amount");
  payRow.reconciled = false;

  await applyHouseEvent(envelope("payment.voided", payment({ status: "voided", void_reason: "mistake" })), { odoo, cache, cfg, mappedId: pay.odoo_id });
  assert.equal(payRow.state, "canceled");
  const cancels = odoo.calls.filter((c) => c.op === "action_cancel").length;
  await applyHouseEvent(envelope("payment.voided", payment({ status: "voided" })), { odoo, cache, cfg, mappedId: pay.odoo_id });
  assert.equal(odoo.calls.filter((c) => c.op === "action_cancel").length, cancels, "an already cancelled payment is left alone");

  const refund = await applyHouseEvent(envelope("payment.refunded", {
    refund_id: "gid://shopify/Refund/9", refund_amount: "200.00", refund_date: "2026-11-15",
    payment: payment(),
  }), { odoo, cache, cfg });
  const refundRow = odoo.db["account.payment"].find((p) => p.id === refund.odoo_id);
  assert.equal(refundRow.payment_type, "outbound");
  assert.equal(refundRow.amount, 200);
  assert.equal(memoHasTag(refundRow.memo, "gid://shopify/Refund/9"), true);
  assert.match(refundRow.memo, /refund of RT:rec_pay/);
  assert.equal(refundRow.payment_method_line_id, 4);
  assert.equal(refundRow.state, "in_process");
});

test("currency, journal and partner lookups are reused within a pass", async () => {
  const odoo = fakeOdoo();
  const cache = {};
  const cfg = { journalId: null };
  const reads = (model) => odoo.calls.filter((c) => c.op === "search_read" && c.model === model).length;
  await applyHouseEvent(envelope("payment.recorded", payment()), { odoo, cache, cfg });
  const partners = reads("res.partner");
  const journals = reads("account.journal");
  const currencies = reads("res.currency");
  assert.ok(partners >= 1 && journals === 1 && currencies === 1);
  await applyHouseEvent(envelope("payment.recorded", payment({ payment_id: "rec_pay2", amount: "10.00" }), { event_id: "evt_pay2" }), { odoo, cache, cfg });
  assert.equal(reads("res.partner"), partners);
  assert.equal(reads("account.journal"), journals);
  assert.equal(reads("res.currency"), currencies);
});

test("a pass persists event ids and Odoo ids, and redacts secrets", async () => {
  const secret = "feed-secret-feed-secret-feed-secret";
  const store = new MemoryStore();
  const logs = [];
  const sync = createSync({
    store, log: (line) => logs.push(line),
    cfg: { enabled: true, allowTest: false, journalId: null, secrets: [secret], reason: "" },
    odoo: fakeOdoo(),
    feed: { async getEvents() { throw new Error("signature failed for " + secret); }, async ack() { return { ok: true }; } },
  });
  const failed = await sync.run();
  assert.equal(failed.ok, false);
  assert.equal(JSON.stringify(failed).includes(secret), false);
  assert.match(failed.message, /\[redacted\]/);
  assert.equal(logs.join("\n").includes(secret), false);
  const status = await sync.status();
  assert.equal(status.enabled, true);
  assert.equal(status.last_run.ok, false);
  assert.equal(JSON.stringify(status).includes(secret), false);

  const kept = new MemoryStore();
  const odoo = fakeOdoo();
  await runPass({ feed: scriptedFeed([{ ok: true, has_more: false, events: [envelope("client.created", env(), { event_id: "evt_keep", record_version: 2 })] }]), store: kept, cfg: quiet, odoo });
  const created = odoo.calls.filter((c) => c.op === "create" && c.model === "res.partner").length;
  await runPass({ feed: scriptedFeed([{ ok: true, has_more: false, events: [envelope("client.created", env(), { event_id: "evt_keep", record_version: 2 })] }]), store: kept, cfg: quiet, odoo });
  assert.equal(odoo.calls.filter((c) => c.op === "create" && c.model === "res.partner").length, created, "a remembered event id is not written again");
  await runPass({ feed: scriptedFeed([{ ok: true, has_more: false, events: [envelope("client.updated", env({ name: "Jordan R" }), { event_id: "evt_next", record_version: 3 })] }]), store: kept, cfg: quiet, odoo });
  assert.equal(odoo.db["res.partner"].length, 1, "the House ref finds the same contact on a later pass");
  assert.equal(odoo.db["res.partner"][0].name, "Jordan R");
  const seen = await kept.get(ODOO_STORE.event, storeId("evt_keep"));
  assert.equal(seen.data.reason, "applied");
  const map = await kept.get(ODOO_STORE.map, storeId("client:rec_client"));
  assert.equal(map.data.version, 3);
  assert.ok(map.data.odoo_id);
  for (const kind of Object.values(ODOO_STORE)) if (kind !== "state") assert.match(kind, /^[a-z][a-z0-9_]{0,63}$/);
  assert.equal(storeId("x".repeat(600)).length < 512, true);
});

test("the worker stays off unless the switch and the values are set", async () => {
  const off = readOdooConfig({});
  assert.equal(off.enabled, false);
  assert.match(off.reason, /ODOO_SYNC_ENABLED/);
  const fetched = [];
  const sync = odooSyncFromEnv({}, { store: new MemoryStore(), fetchImpl: async () => { fetched.push(1); return new Response("{}", { status: 500 }); } });
  assert.equal(sync.enabled, false);
  const ran = await sync.run();
  assert.equal(ran.ran, false);
  assert.equal(fetched.length, 0);
  const partial = readOdooConfig({ ODOO_SYNC_ENABLED: "true", ODOO_URL: "https://odoo.example", ODOO_API_KEY: "super-secret-api-key-value" });
  assert.equal(partial.enabled, false);
  assert.match(partial.reason, /REPAINT_FEED_SECRET/);
  assert.equal(partial.reason.includes("super-secret-api-key-value"), false);
  const good = readOdooConfig({
    ODOO_SYNC_ENABLED: "true", ODOO_URL: "https://the-house-of-royal-t-design1.odoo.com", ODOO_DB: "the-house-of-royal-t-design1",
    ODOO_API_KEY: "odoo-api-key-value-xxxx", REPAINT_FEED_KEY_ID: "odoo-1", REPAINT_FEED_SECRET: "feed-secret-feed-secret-feed-secret",
    ODOO_SYNC_ALLOW_TEST: "true", ODOO_PAYMENT_JOURNAL_ID: "7",
  });
  assert.equal(good.enabled, true);
  assert.equal(good.allowTest, true);
  assert.equal(good.journalId, 7);
  assert.equal(good.feedBase, "https://thehouseofroyaltdesign.com/api/odoo-bridge/v1");
});

test("bridge.test is acknowledged through the real signer and Odoo is not called", async () => {
  const secret = "feed-secret-feed-secret-feed-secret";
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(url);
    if (String(url).includes("/json/2/")) throw new Error("Odoo was called for a test ack");
    if (String(url).includes("/events?")) {
      assert.match(String(url), /after=0&limit=50/);
      assert.equal(init.headers["X-RT-Content-SHA256"], EMPTY_BODY_SHA256);
      return new Response(JSON.stringify({ ok: true, has_more: false, events: [envelope("bridge.test", { message: "Test event from The House.", requested_by: "Tah Bey" }, { event_id: "evt_bridge" })] }), { status: 200 });
    }
    const body = JSON.parse(init.body);
    assert.deepEqual(body.delivered, ["evt_bridge"]);
    assert.deepEqual(body.failed, []);
    return new Response(JSON.stringify({ ok: true, delivered: 1, failed: 0, ignored: [] }), { status: 200 });
  };
  const sync = odooSyncFromEnv({
    ODOO_SYNC_ENABLED: "true", ODOO_URL: "https://the-house-of-royal-t-design1.odoo.com", ODOO_DB: "the-house-of-royal-t-design1",
    ODOO_API_KEY: "odoo-api-key-value-xxxx", REPAINT_FEED_KEY_ID: "odoo-1", REPAINT_FEED_SECRET: secret,
    REPAINT_FEED_BASE_URL: "https://feed.example/api/odoo-bridge/v1", ODOO_SYNC_RUN_SECRET: "run-secret-run-secret",
  }, { store: new MemoryStore(), fetchImpl, log() {} });
  const result = await sync.run();
  assert.equal(result.ok, true);
  assert.equal(result.applied, 0);
  assert.equal(result.skipped, 1);
  assert.equal(seen.some((u) => String(u).includes("/json/2/")), false);
  assert.equal(sync.secretOk("run-secret-run-secret"), true);
  assert.equal(sync.secretOk("run-secret-run-secret-nope"), false);
  assert.equal(Object.hasOwn(sync, "runSecret"), false);
});

test("the sync routes need the owner or the run secret, and a member cannot use them", async () => {
  const USERS = { "t-owner": { id: "u-tahir", role: "owner" }, "t-member": { id: "u-tori", role: "member" } };
  const runs = [];
  const odooSync = {
    enabled: true,
    secretOk: (h) => h === "run-secret-run-secret",
    async status() { return { ok: true, enabled: true, counts: { runs: 0, delivered: 0, failed: 0, skipped: 0, applied: 0 }, last_run: null, last_errors: [] }; },
    async run() { runs.push(1); return { ok: true, enabled: true, ran: true, applied: 0, failed: 0, skipped: 0, delivered: 0, errors: [] }; },
  };
  const lines = [];
  const royal = createRoyal({ store: new MemoryStore() });
  const handler = createHandler({ royal, auth: async (t) => USERS[t] || null, odooSync, log: (l) => lines.push(l) });
  const call = (method, path, { token, secret } = {}) => handler(new Request("https://royal.test" + path, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...(secret ? { "X-Royal-Sync-Secret": secret } : {}) },
    body: method === "POST" ? "{}" : undefined,
  }));
  assert.equal((await call("GET", "/v1/odoo-sync/status")).status, 401);
  assert.equal((await call("POST", "/v1/odoo-sync/run", { token: "t-member" })).status, 403);
  assert.equal((await call("GET", "/v1/odoo-sync/run", { token: "t-owner" })).status, 405);
  assert.equal((await call("GET", "/v1/odoo-sync/status", { token: "t-owner" })).status, 200);
  assert.equal((await call("POST", "/v1/odoo-sync/run", { secret: "run-secret-run-secret" })).status, 200);
  assert.equal((await call("POST", "/v1/odoo-sync/run", { secret: "nope" })).status, 401);
  assert.equal(runs.length, 1);
  const bare = createHandler({ royal, auth: async (t) => USERS[t] || null });
  assert.equal((await bare(new Request("https://royal.test/v1/odoo-sync/status", { headers: { Authorization: "Bearer t-owner" } }))).status, 404);
  assert.equal(JSON.stringify(lines).includes("run-secret-run-secret"), false);
  const health = await handler(new Request("https://royal.test/v1/health"));
  assert.equal(health.status, 200);
  const command = await handler(new Request("https://royal.test/v1/command", { method: "POST", headers: { Authorization: "Bearer t-owner", "Content-Type": "application/json" }, body: JSON.stringify({ content: "What needs me?" }) }));
  assert.equal(command.status, 200);
});
