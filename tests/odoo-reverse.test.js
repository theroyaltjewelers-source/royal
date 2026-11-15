import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../core/store.js";
import { planEvent } from "../core/odoo/plan.js";
import { runPass } from "../core/odoo/sync.js";
import { pushChanges, readChangeResults, toBatchPayload } from "../core/odoo/changes.js";
import {
  REVERSE_ID, REVERSE_KIND, contactChange, decideFields, fingerprint, houseIdFromMemo, inquiryChange, inquiryStatusFromLead,
  looksShopify, noteForwardWrite, paymentChange, paymentMethodFromOdoo, runReverse,
} from "../core/odoo/reverse.js";

const at = "2026-11-15T18:00:00Z";

test("lead stage and payment method map onto the House's allowed values", () => {
  assert.equal(inquiryStatusFromLead({ stage_id: [1, "New"], won_status: "pending", active: true }), "new");
  assert.equal(inquiryStatusFromLead({ stage_id: [2, "Won"], won_status: "won", active: true }), "converted");
  assert.equal(inquiryStatusFromLead({ stage_id: [3, "Qualified"], won_status: "lost", active: false }), "closed");
  assert.equal(inquiryStatusFromLead({ stage_id: [4, "Quoting"], won_status: "pending", active: true }), "quoting");
  assert.equal(inquiryStatusFromLead({ stage_id: [5, "Proposition"], won_status: "pending", active: true }), "contacted");
  assert.equal(inquiryStatusFromLead({ stage_id: [6, "Waiting on reply"], won_status: "pending", active: true }), "contacted");
  assert.equal(paymentMethodFromOdoo({ payment_method_line_id: [1, "Manual"], journal_id: [2, "Bank"] }), "other");
  assert.equal(paymentMethodFromOdoo({ payment_method_line_id: [1, "Zelle"], journal_id: [2, "Bank"] }), "zelle");
  assert.equal(paymentMethodFromOdoo({ payment_method_line_id: [1, "Wire transfer"], journal_id: [2, "Bank"] }), "wire");
  assert.equal(paymentMethodFromOdoo({ journal_id: [3, "Cash"] }), "cash");
  assert.equal(looksShopify({ payment_method_line_id: [1, "Shopify"], journal_id: [2, "Bank"] }), true);
});

test("a fingerprint of our own write is skipped, and the newer edit wins per field", async () => {
  const store = new MemoryStore();
  const event = { event_id: "evt_1", event_type: "client.updated", occurred_at: at, record_version: 41, data: {
    client_id: "rec_client", name: "Jordan Reyes", email: "jordan@example.com", phone: "+1 555 0100", address: "12 Main St", archived: false,
  } };
  await noteForwardWrite(store, event, 88, () => new Date(at));
  const same = { name: "Jordan Reyes", first_name: "Jordan", last_name: "Reyes", email: "jordan@example.com", phone: "+1 555 0100", address: "12 Main St", archived: "false" };
  const shadow = (await store.get("odoo_shadow", "client:rec_client")).data;
  assert.equal(shadow.fingerprint, fingerprint(same));
  assert.equal(shadow.version, 41);
  assert.equal(decideFields("contact", same, shadow, Date.parse("2026-11-15T19:00:00Z")).reason, "echo");

  const renamed = { ...same, name: "Jordan R" };
  const newer = decideFields("contact", renamed, shadow, Date.parse("2026-11-15T19:00:00Z"));
  assert.equal(newer.action, "send");
  assert.equal(newer.fields.name, "Jordan R");
  const tie = decideFields("contact", renamed, shadow, Date.parse(at));
  assert.equal(tie.action, "skip");
  assert.equal(tie.reason, "dashboard-wins");
  const older = decideFields("contact", renamed, shadow, Date.parse("2026-11-15T17:00:00Z"));
  assert.equal(older.reason, "dashboard-wins");
});

test("changes match the House contract, including dedupe and if_version", () => {
  const contact = contactChange({ id: 88, ref: "RT:rec_client", write_date: "2026-11-15 19:00:00" }, { name: "Jordan Reyes", email: "jordan@example.com", archived: "false" }, 41);
  assert.equal(contact.type, "contact.update");
  assert.equal(contact.house_id, "rec_client");
  assert.equal(contact.if_version, 41);
  assert.equal(contact.archived, false);
  assert.equal(contact.ref, "res.partner/88");
  assert.equal("dry_run" in contact, false);

  const created = paymentChange({ id: 512 }, { amount: "850.00", date: "2026-11-15", method: "other", memo: "deposit", client_id: "rec_client", email: "jordan@example.com" }, "");
  assert.equal(created.type, "payment.create");
  assert.equal(created.odoo_payment_id, "512");
  assert.equal(created.client_id, "rec_client");
  assert.equal(created.amount, "850.00");
  assert.equal(created.method, "other");
  assert.equal("if_version" in created, false);
  assert.equal(created.client_email, undefined);
  const byEmail = paymentChange({ id: 9 }, { amount: "10.00", date: "2026-11-15", method: "cash", email: " Jordan@Example.com " }, "");
  assert.equal(byEmail.client_email, "jordan@example.com");

  const updated = paymentChange({ id: 512 }, { amount: "900.00", method: "other" }, "rec_pay", 7);
  assert.equal(updated.type, "payment.update");
  assert.equal(updated.house_id, "rec_pay");
  assert.equal(updated.if_version, 7);
  assert.equal(updated.amount, "900.00");
  assert.equal(updated.method, undefined);
  assert.equal(paymentChange({ id: 512 }, { method: "other" }, "rec_pay", 7), null);

  const voided = paymentChange({ id: 512 }, { status: "voided" }, "rec_pay", 7);
  assert.equal(voided.type, "payment.void");
  assert.equal(voided.house_id, "rec_pay");
  assert.equal(houseIdFromMemo("RT:rec_pay #1042"), "rec_pay");

  const inquiry = inquiryChange({ id: 301, description: "House inquiry RT:rec_inq\nStatus: new" }, { status: "contacted" }, 3);
  assert.deepEqual(Object.keys(inquiry).sort(), ["house_id", "if_version", "ref", "status", "type"]);
  assert.equal(inquiry.type, "inquiry.status");
  assert.deepEqual(Object.keys(toBatchPayload([contact, created])), ["changes"]);
});

test("results distinguish applied, duplicate and not_allowed, and 429 is retried", async () => {
  const sent = [{ ref: "account.payment/512", type: "payment.create" }];
  const parsed = readChangeResults({ ok: true, results: [
    { ref: "account.payment/512", type: "payment.create", ok: true, status: "duplicate", house_id: "rec_pay", version: 9, event_id: "evt_9", event_origin: "odoo", code: "", error: "" },
  ] }, sent);
  assert.equal(parsed[0].ok, true);
  assert.equal(parsed[0].status, "duplicate");
  assert.equal(parsed[0].house_id, "rec_pay");
  assert.equal(parsed[0].version, 9);
  const refused = readChangeResults({ ok: true, results: [
    { ref: "account.payment/9", type: "payment.update", ok: false, status: "rejected", code: "not_allowed", error: "Shopify", house_id: "", version: null },
  ] }, [{ ref: "account.payment/9", type: "payment.update" }]);
  assert.equal(refused[0].ok, false);
  assert.equal(refused[0].code, "not_allowed");

  const waits = [];
  let hits = 0;
  const out = await pushChanges(async () => {
    hits++;
    if (hits === 1) return { status: 429, retryAfter: "2", json: { ok: false, error: "slow" } };
    return { status: 200, json: { ok: true, results: [{ ref: "res.partner/1", type: "contact.update", ok: true, status: "applied", house_id: "rec_client", version: 57, event_id: "evt_57", event_origin: "odoo", code: "", error: "" }] } };
  }, [{ ref: "res.partner/1", type: "contact.update" }], { sleep: async (ms) => waits.push(ms), now: () => 0 });
  assert.equal(hits, 2);
  assert.deepEqual(waits, [2000]);
  assert.equal(out.results[0].status, "applied");
  assert.equal(out.results[0].version, 57);
});

test("runPass with reverse sync on does not require a log function", async () => {
  const store = new MemoryStore();
  const feed = {
    async getEvents() { return { ok: true, events: [], has_more: false }; },
    async ack() { return { ok: true }; },
    async changes() { throw new Error("nothing to post"); },
  };
  const result = await runPass({
    feed, store, odoo: { async searchRead() { return []; } },
    cfg: { reverseEnabled: true, reverseDryRun: false, allowTest: false, secrets: [] },
  });
  assert.equal(result.reverse.initialized, true);
  assert.equal(result.reverse.sent, 0);
  assert.equal(result.applied, 0);
});

test("origin odoo is acknowledged and not written back; a missing origin is the House", () => {
  assert.equal(planEvent({ event_id: "evt_o", event_type: "client.updated", origin: "odoo", record_version: 57, data: { client_id: "rec_client" } }).reason, "origin-odoo");
  assert.equal(planEvent({ event_id: "evt_h", event_type: "client.updated", origin: "house", record_version: 4, data: { client_id: "rec_client" } }).action, "apply");
  assert.equal(planEvent({ event_id: "evt_old", event_type: "client.updated", record_version: 4, data: { client_id: "rec_client" } }).action, "apply");
});

function odooWith(pages, partners = []) {
  const calls = [];
  return {
    calls,
    async searchRead(model, spec) {
      calls.push({ model, order: spec.order || "" });
      if (String(spec.order).includes("desc")) return [{ id: 1, write_date: "2026-11-15 18:00:00" }];
      if (JSON.stringify(spec.domain || []).includes('"in"')) return partners.slice();
      return (pages[model] || []).slice();
    },
    async write(model, ids, vals) {
      calls.push({ op: "write", model, ids, vals });
      for (const row of pages[model] || []) if (ids.includes(row.id)) Object.assign(row, vals);
    },
  };
}

async function seeded(store) {
  await store.put(REVERSE_KIND, REVERSE_ID, {
    "res.partner": { write_date: "2026-11-15 18:00:00", id: 1 },
    "crm.lead": { write_date: "2026-11-15 18:00:00", id: 1 },
    "account.payment": { write_date: "2026-11-15 18:00:00", id: 1 },
  }, null);
}

test("first sight of a linked contact is a baseline, and a later edit sends only the changed field", async () => {
  const store = new MemoryStore();
  await seeded(store);
  const row = { id: 88, name: "Jordan Reyes", email: "jordan@example.com", phone: "", street: "", street2: "", ref: "RT:rec_client", active: true, write_date: "2026-11-15 19:00:00" };
  const odoo = odooWith({ "res.partner": [row] });
  const bodies = [];
  const post = async (body) => {
    bodies.push(body);
    return { status: 200, json: { ok: true, results: body.changes.map((change) => ({ ref: change.ref, type: change.type, ok: true, status: "applied", house_id: change.house_id, version: 2, event_id: "evt_2", event_origin: "odoo", code: "", error: "" })) } };
  };
  const first = await runReverse({ odoo, store, post, now: () => new Date("2026-11-15T20:00:00Z") });
  assert.equal(first.sent, 0);
  assert.equal(bodies.length, 0);
  assert.ok((await store.get("odoo_shadow", "client:rec_client")).data.fingerprint);
  row.name = "Jordan R";
  row.write_date = "2026-11-15 21:00:00";
  const second = await runReverse({ odoo, store, post, now: () => new Date("2026-11-15T22:00:00Z") });
  assert.equal(second.sent, 1);
  assert.equal(bodies[0].changes[0].name, "Jordan R");
  assert.equal(bodies[0].changes[0].phone, undefined);
  assert.equal(bodies[0].changes[0].address, undefined);
  assert.equal(bodies[0].changes[0].email, undefined);
});

test("a future payment does not block a payment dated today", async () => {
  const store = new MemoryStore();
  await seeded(store);
  const future = { id: 10, amount: 20, date: "2026-12-01", memo: "later", state: "posted", partner_id: [7, "Jordan"], payment_method_line_id: [1, "Manual"], journal_id: [2, "Bank"], currency_id: [1, "USD"], write_date: "2026-11-15 19:00:00" };
  const today = { id: 11, amount: 30, date: "2026-11-15", memo: "now", state: "posted", partner_id: [7, "Jordan"], payment_method_line_id: [1, "Manual"], journal_id: [2, "Bank"], currency_id: [1, "USD"], write_date: "2026-11-15 19:01:00" };
  const odoo = odooWith({ "account.payment": [future, today] }, [{ id: 7, ref: "RT:rec_client", email: "Jordan@Example.com", name: "Jordan" }]);
  const bodies = [];
  const post = async (body) => {
    bodies.push(body);
    return { status: 200, json: { ok: true, results: body.changes.map((change) => ({ ref: change.ref, type: change.type, ok: true, status: "applied", house_id: "rec_" + change.odoo_payment_id, version: 1, event_id: "evt", event_origin: "odoo", code: "", error: "" })) } };
  };
  const first = await runReverse({ odoo, store, post, now: () => new Date("2026-11-15T20:00:00Z") });
  assert.equal(first.sent, 1);
  assert.equal(bodies[0].changes.length, 1);
  assert.equal(bodies[0].changes[0].odoo_payment_id, "11");
  assert.equal(bodies[0].changes[0].client_email, undefined);
  assert.equal(bodies[0].changes[0].client_id, "rec_client");
  const cursor = (await store.get(REVERSE_KIND, REVERSE_ID)).data;
  assert.equal(cursor.deferred["10"].date, "2026-12-01");
  assert.ok(cursor["account.payment"].write_date >= "2026-11-15 19:01:00");
  const later = await runReverse({ odoo, store, post, now: () => new Date("2026-12-01T12:00:00Z") });
  assert.equal(later.sent, 1);
  assert.equal(bodies[1].changes[0].odoo_payment_id, "10");
  assert.equal((await store.get(REVERSE_KIND, REVERSE_ID)).data.deferred["10"], undefined);
});

test("a new Odoo payment is created once, then the same id is not sent again", async () => {
  const store = new MemoryStore();
  await seeded(store);
  const row = { id: 512, amount: 850, date: "2026-11-15", memo: "deposit", state: "posted", partner_id: [7, "Jordan"], payment_method_line_id: [1, "Manual"], journal_id: [2, "Bank"], currency_id: [1, "USD"], write_date: "2026-11-15 19:00:00" };
  const odoo = odooWith({ "account.payment": [row] }, [{ id: 7, ref: "RT:rec_client", email: "jordan@example.com", name: "Jordan" }]);
  const bodies = [];
  const post = async (body) => {
    bodies.push(body);
    return { status: 200, json: { ok: true, results: body.changes.map((change) => ({ ref: change.ref, type: change.type, ok: true, status: "applied", house_id: "rec_pay", version: 3, event_id: "evt_3", event_origin: "odoo", code: "", error: "" })) } };
  };
  const first = await runReverse({ odoo, store, post, now: () => new Date("2026-11-15T20:00:00Z") });
  assert.equal(first.sent, 1);
  assert.equal(bodies[0].changes[0].type, "payment.create");
  assert.equal(bodies[0].changes[0].odoo_payment_id, "512");
  assert.equal(bodies[0].changes[0].client_id, "rec_client");
  assert.equal("if_version" in bodies[0].changes[0], false);
  assert.equal(bodies[0].dry_run, undefined);
  const second = await runReverse({ odoo, store, post, now: () => new Date("2026-11-15T20:05:00Z") });
  assert.equal(second.sent, 0);
  assert.equal(bodies.length, 1, "the Odoo payment id is not created twice");
});

test("a version conflict applies the feed and then resends with the new if_version", async () => {
  const store = new MemoryStore();
  await seeded(store);
  await noteForwardWrite(store, { event_id: "evt_1", event_type: "client.updated", occurred_at: "2026-11-15T18:00:00Z", record_version: 4, data: {
    client_id: "rec_client", name: "Jordan Reyes", email: "jordan@example.com", phone: "1", address: "12 Main", archived: false,
  } }, 88, () => new Date("2026-11-15T18:00:00Z"));
  const odoo = odooWith({ "res.partner": [{ id: 88, name: "Jordan R", email: "jordan@example.com", phone: "1", street: "12 Main", street2: "", ref: "RT:rec_client", active: true, write_date: "2026-11-15 19:30:00" }] });
  const seen = [];
  let conflicted = false;
  const post = async (body) => {
    seen.push(body.changes[0].if_version);
    if (!conflicted) {
      conflicted = true;
      return { status: 200, json: { ok: true, results: [{ ref: body.changes[0].ref, type: "contact.update", ok: false, status: "rejected", code: "conflict", version: 9, event_id: "evt_9", event_origin: "house", house_id: "rec_client", error: "newer" }] } };
    }
    return { status: 200, json: { ok: true, results: [{ ref: body.changes[0].ref, type: "contact.update", ok: true, status: "applied", code: "", version: 10, event_id: "evt_10", event_origin: "odoo", house_id: "rec_client", error: "" }] } };
  };
  const summary = await runReverse({
    odoo, store, post, now: () => new Date("2026-11-15T20:00:00Z"),
    onConflict: async () => {
      await noteForwardWrite(store, { event_id: "evt_9", event_type: "client.updated", occurred_at: "2026-11-15T19:00:00Z", record_version: 9, data: {
        client_id: "rec_client", name: "Jordan Reyes", email: "jordan@example.com", phone: "1", address: "12 Main", archived: false,
      } }, 88, () => new Date("2026-11-15T19:00:00Z"));
    },
  });
  assert.deepEqual(seen, [4, 9]);
  assert.equal(summary.sent, 1);
  assert.equal(summary.held, 0);
});
