/* Odoo -> House dashboard.
   Poll write_date. Push contacts, inquiry status, and payments Tahir edits
   in Odoo. The API key is his own user, so write_uid cannot tell his edits
   from ours. A fingerprint of the fields we last wrote is the echo check.
   Newest edit wins per field. The same time means the dashboard wins.

   The first time reverse sync runs, the cursor is set to the newest
   write_date already in Odoo and nothing is sent. History from before the
   switch is not copied. Save a record again to push it. */

import { createHash } from "node:crypto";
import { pushChanges } from "./changes.js";

export const SHADOW = "odoo_shadow";
export const REVERSE_KIND = "odoo_reverse";
export const REVERSE_ID = "cursor";

const OPEN = new Set(["new", "contacted", "quoting", "awaiting_reply"]);

function text(v) {
  if (v == null) return "";
  return String(v).trim();
}

export function fingerprint(fields) {
  const stable = {};
  for (const key of Object.keys(fields || {}).sort()) stable[key] = fields[key] == null ? "" : String(fields[key]);
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function timeMs(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T") + (raw.endsWith("Z") ? "" : "Z");
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/* True only when Odoo is strictly newer. A tie keeps the dashboard value. */
export function odooWins(odooAt, dashAt) {
  if (odooAt == null) return false;
  if (dashAt == null) return true;
  return odooAt > dashAt;
}

export function houseIdFromRef(ref) {
  const s = text(ref);
  return s.startsWith("RT:") ? s.slice(3) : "";
}

export function houseIdFromInquiry(description) {
  const marker = "House inquiry RT:";
  const s = text(description);
  const at = s.indexOf(marker);
  if (at < 0) return "";
  return s.slice(at + marker.length).split(/\s/)[0] || "";
}

export function houseIdFromMemo(memo) {
  const s = text(memo);
  if (!s.startsWith("RT:")) return "";
  return s.slice(3).split(/[\s|]/)[0] || "";
}

export function moneyText(value) {
  const n = typeof value === "number" ? value : Number(text(value));
  if (!Number.isFinite(n)) return "";
  return (Math.round(n * 100) / 100).toFixed(2);
}

/* Stage names from a normal CRM pipeline.
   New -> new. Won, or a won stage -> converted. Lost, or an archived lead -> closed.
   A stage whose name mentions a quote -> quoting. A stage whose name says
   we are waiting -> awaiting_reply. Any other open stage -> contacted. */
export function inquiryStatusFromLead(row) {
  const stage = Array.isArray(row.stage_id) ? text(row.stage_id[1]) : text(row.stage_name || row.stage);
  if (row.won_status === "won" || row.is_won === true || /^won$/i.test(stage)) return "converted";
  if (row.won_status === "lost" || row.active === false) return "closed";
  if (/quot/i.test(stage)) return "quoting";
  /* The inbound contract accepts new, contacted, quoting, converted, closed.
     A waiting stage is the closest open status, contacted. */
  if (/^new$/i.test(stage) || !stage) return "new";
  return "contacted";
}

export function looksShopify(row) {
  const method = text(row.payment_method_name || (Array.isArray(row.payment_method_line_id) ? row.payment_method_line_id[1] : ""));
  const journal = text(row.journal_type || (Array.isArray(row.journal_id) ? row.journal_id[1] : ""));
  return /shopify/i.test(method + " " + journal + " " + text(row.memo));
}

export function paymentMethodFromOdoo(row) {
  const name = text(row.payment_method_name || (Array.isArray(row.payment_method_line_id) ? row.payment_method_line_id[1] : "")).toLowerCase();
  const journal = text(row.journal_type || (Array.isArray(row.journal_id) ? row.journal_id[1] : "")).toLowerCase();
  if (name.includes("zelle")) return "zelle";
  if (name.includes("wire") || name.includes("transfer") || name.includes("sepa")) return "wire";
  if (name.includes("check") || name.includes("cheque")) return "check";
  if (name.includes("card")) return "card";
  if (journal.includes("cash") || name.includes("cash")) return "cash";
  return "other";
}

export function contactProjection(row) {
  const name = text(row.name);
  const bits = name.split(/\s+/).filter(Boolean);
  return {
    name,
    first_name: bits[0] || "",
    last_name: bits.slice(1).join(" "),
    email: text(row.email),
    phone: text(row.phone),
    address: (text(row.street) + text(row.street2)).slice(0, 256),
    archived: row.active === false ? "true" : "false",
  };
}

export function leadProjection(row) {
  const stage = Array.isArray(row.stage_id) ? text(row.stage_id[1]) : text(row.stage_name || row.stage);
  return { status: inquiryStatusFromLead(row), stage };
}

export function paymentProjection(row, partner) {
  const state = text(row.state);
  const voided = state === "cancel" || state === "canceled" || state === "cancelled";
  return {
    amount: moneyText(row.amount),
    date: text(row.date).slice(0, 10),
    memo: text(row.memo),
    method: paymentMethodFromOdoo(row),
    status: voided ? "voided" : "posted",
    currency: (Array.isArray(row.currency_id) ? text(row.currency_id[1]) : text(row.currency)) || "USD",
    client_id: houseIdFromRef(partner && partner.ref),
    email: text(partner && partner.email),
  };
}

function shadowFields(fields, at) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) out[key] = { value: value == null ? "" : String(value), at: at || "" };
  return out;
}

/* What our own write should look like when it is read back, so the next
   poll can recognise it. Open inquiry stages are not written by us, so the
   stage is filled in on the first later look and not treated as Tahir's edit. */
export function echoFromHouseEvent(event, odooId) {
  const data = (event && event.data) || {};
  const at = event && event.occurred_at || "";
  const type = event && event.event_type || "";
  if (type === "client.created" || type === "client.updated") {
    const name = text(data.name) || [data.first_name, data.last_name].map(text).filter(Boolean).join(" ");
    const bits = name.split(/\s+/).filter(Boolean);
    const fields = {
      name, first_name: bits[0] || "", last_name: bits.slice(1).join(" "),
      email: text(data.email), phone: text(data.phone),
      address: text(data.address).slice(0, 256), archived: data.archived === true ? "true" : "false",
    };
    return { kind: "contact", houseKey: "client:" + text(data.client_id), odooKey: odooId ? "res.partner:" + odooId : "", fields, at };
  }
  if (type === "inquiry.created" || type === "inquiry.updated") {
    const status = text(data.status) || "new";
    const fields = { status, stage: OPEN.has(status) ? "" : (status === "converted" ? "Won" : "Lost") };
    return { kind: "inquiry", houseKey: "inquiry:" + text(data.inquiry_id), odooKey: odooId ? "crm.lead:" + odooId : "", fields, at, stageBaseline: OPEN.has(status) };
  }
  if (type === "payment.recorded" || type === "payment.updated" || type === "payment.voided") {
    const id = text(data.payment_id);
    const extra = [data.memo, data.reference, data.description].map(text).filter(Boolean).join(" ");
    const memo = extra ? ("RT:" + id + " " + extra).slice(0, 250) : "RT:" + id;
    const fields = {
      amount: moneyText(data.amount), date: text(data.date).slice(0, 10), memo,
      method: text(data.method) || "other", status: type === "payment.voided" || data.status === "voided" ? "voided" : "posted",
      currency: text(data.currency) || "USD", client_id: text(data.client_id), email: text(data.email),
    };
    return { kind: "payment", houseKey: "payment:" + id, odooKey: odooId ? "account.payment:" + odooId : "", fields, at };
  }
  return null;
}

async function cas(store, kind, id, fn) {
  for (let i = 0; i < 8; i++) {
    const cur = await store.get(kind, id);
    const next = await fn(cur ? cur.data : null);
    if (next === undefined) return cur;
    const rec = await store.put(kind, id, next, cur ? cur.rev : null);
    if (rec.ok) return { data: next, rev: rec.rev };
  }
  throw new Error("I could not save the reverse sync record.");
}

export async function noteForwardWrite(store, event, odooId, now) {
  const echo = echoFromHouseEvent(event, odooId);
  if (!echo || !echo.houseKey) return null;
  const at = echo.at || (now ? now().toISOString() : "");
  const version = Number(event && event.record_version);
  const data = {
    kind: echo.kind, house_id: echo.houseKey.split(":").slice(1).join(":"),
    fingerprint: fingerprint(echo.fields), fields: shadowFields(echo.fields, at),
    dashboard: shadowFields(echo.fields, at), stage_baseline: !!echo.stageBaseline, at,
    version: Number.isFinite(version) ? version : null,
  };
  await cas(store, SHADOW, echo.houseKey, () => data);
  if (echo.odooKey) await cas(store, SHADOW, echo.odooKey, () => ({ ...data, house_key: echo.houseKey }));
  return data;
}

/* Per field: Odoo must be strictly newer than the dashboard's last edit.
   An open inquiry whose stage we have not baselined yet is our own write. */
export function decideFields(kind, projection, shadow, odooAt) {
  const fp = fingerprint(projection);
  if (shadow && shadow.fingerprint === fp) return { action: "skip", reason: "echo", fields: {} };
  if (kind === "inquiry" && shadow && shadow.stage_baseline && OPEN.has(shadow.fields && shadow.fields.status && shadow.fields.status.value) && OPEN.has(projection.status)) {
    const known = shadow.fields && shadow.fields.stage && shadow.fields.stage.value;
    if (!known) return { action: "baseline", reason: "stage-baseline", fields: {}, stage: projection.stage, status: shadow.fields.status.value };
    if (known === projection.stage) return { action: "skip", reason: "echo", fields: {} };
  }
  const fields = {};
  for (const [key, value] of Object.entries(projection)) {
    if (key === "stage") continue;
    const current = value == null ? "" : String(value);
    const prev = shadow && shadow.fields && shadow.fields[key];
    if (prev && prev.value === current) continue;
    const dash = shadow && shadow.dashboard && shadow.dashboard[key];
    if (dash && dash.value !== current && !odooWins(odooAt, timeMs(dash.at))) continue;
    fields[key] = current;
  }
  if (!Object.keys(fields).length) return { action: "skip", reason: shadow ? "dashboard-wins" : "unchanged", fields: {} };
  return { action: "send", reason: "", fields };
}

export function sinceDomain(link, cursor) {
  if (!cursor || !cursor.write_date) return link;
  const newer = ["|", ["write_date", ">", cursor.write_date], "&", ["write_date", "=", cursor.write_date], ["id", ">", cursor.id || 0]];
  return ["&", link, newer];
}

function withVersion(body, version) {
  if (Number.isFinite(version)) body.if_version = version;
  return body;
}

/* Contract types only. Omitted fields stay as they are on the dashboard. */
export function contactChange(row, fields, version) {
  const body = withVersion({ ref: "res.partner/" + row.id, type: "contact.update", house_id: houseIdFromRef(row.ref) }, version);
  if (fields.name != null) body.name = String(fields.name);
  if (fields.email != null) body.email = String(fields.email);
  if (fields.phone != null) body.phone = String(fields.phone);
  if (fields.address != null) body.address = String(fields.address).slice(0, 500);
  if (fields.archived != null) body.archived = fields.archived === true || fields.archived === "true";
  return body;
}

export function inquiryChange(row, fields, version) {
  const body = withVersion({
    ref: "crm.lead/" + row.id, type: "inquiry.status", house_id: houseIdFromInquiry(row.description), status: fields.status,
  }, version);
  return body;
}

export function houseMemo(memo) {
  const s = text(memo);
  if (!s.startsWith("RT:")) return s.slice(0, 120);
  const rest = s.slice(3).split(/[\s|]/).slice(1).join(" ").trim();
  return (rest || s).slice(0, 120);
}

export function paymentChange(row, fields, housePaymentId, version) {
  const ref = "account.payment/" + row.id;
  const odooId = String(row.id);
  const voided = fields.status === "voided";
  if (voided && housePaymentId) return withVersion({ ref, type: "payment.void", house_id: housePaymentId, odoo_payment_id: odooId, reason: "Voided in Odoo" }, version);
  if (voided) return withVersion({ ref, type: "payment.void", odoo_payment_id: odooId, reason: "Voided in Odoo" }, version);
  if (!housePaymentId) {
    const body = {
      ref, type: "payment.create", odoo_payment_id: odooId, amount: fields.amount, date: fields.date, method: fields.method || "other",
    };
    if (fields.client_id) body.client_id = fields.client_id;
    else body.client_email = fields.email;
    const memo = houseMemo(fields.memo);
    if (memo) body.memo = memo;
    return body;
  }
  const body = withVersion({ ref, type: "payment.update", house_id: housePaymentId, odoo_payment_id: odooId, reason: "Changed in Odoo" }, version);
  if (fields.amount != null) body.amount = fields.amount;
  if (fields.date != null) body.date = fields.date;
  /* "other" is the fallback when Odoo has no cash, card, zelle, wire or check
     name. Sending it would wipe a method the House already knows. */
  if (fields.method && fields.method !== "other") body.method = fields.method;
  if (fields.memo != null) body.memo = houseMemo(fields.memo);
  if (body.amount == null && body.date == null && body.method == null && body.memo == null) return null;
  return body;
}

async function loadShadow(store, odooKey, houseKey) {
  if (houseKey) {
    const row = await store.get(SHADOW, houseKey);
    if (row && row.data) return { id: houseKey, data: row.data };
  }
  if (odooKey) {
    const row = await store.get(SHADOW, odooKey);
    if (row && row.data) return { id: row.data.house_key || odooKey, data: row.data };
  }
  return null;
}

async function saveShadow(store, keys, data) {
  for (const key of keys) if (key) await cas(store, SHADOW, key, () => data);
}

function m2o(value) {
  if (Array.isArray(value)) return value[0];
  if (value && typeof value === "object") return value.id;
  return value || null;
}

export async function runReverse({ odoo, post, store, dryRun = false, now = () => new Date(), log = () => {}, sleep, maxRetries, onConflict } = {}) {
  const summary = { ok: true, dry_run: !!dryRun, initialized: false, sent: 0, skipped: 0, failed: 0, held: 0, errors: [], preview: [] };
  const cursorRow = await store.get(REVERSE_KIND, REVERSE_ID);
  const cursor = (cursorRow && cursorRow.data) || {};
  const models = [
    { name: "res.partner", link: ["ref", "=like", "RT:%"], fields: ["id", "name", "email", "phone", "street", "street2", "ref", "active", "write_date"] },
    { name: "crm.lead", link: ["description", "ilike", "House inquiry RT:"], fields: ["id", "description", "stage_id", "won_status", "active", "write_date"], context: { active_test: false } },
    { name: "account.payment", link: ["partner_type", "=", "customer"], fields: ["id", "amount", "date", "memo", "state", "partner_id", "payment_method_line_id", "journal_id", "currency_id", "write_date"], context: { active_test: false } },
  ];
  let seeded = false;
  for (const model of models) {
    if (!cursor[model.name]) {
      const latest = await odoo.searchRead(model.name, { domain: [model.link], fields: ["id", "write_date"], limit: 1, order: "write_date desc, id desc", context: model.context });
      const top = latest && latest[0];
      cursor[model.name] = top ? { write_date: top.write_date || "", id: top.id || 0 } : { write_date: "1970-01-01 00:00:00", id: 0 };
      seeded = true;
    }
  }
  if (seeded) {
    await cas(store, REVERSE_KIND, REVERSE_ID, () => cursor);
    summary.initialized = true;
    log("ROYAL: reverse sync is watching edits made from now on.");
  }

  const outgoing = [];
  const accepted = [];
  for (const model of models) {
    const domain = sinceDomain(model.link, cursor[model.name]);
    const rows = await odoo.searchRead(model.name, { domain, fields: model.fields, limit: 50, order: "write_date asc, id asc", context: model.context });
    const partners = {};
    if (model.name === "account.payment") {
      const ids = [...new Set(rows.map((row) => m2o(row.partner_id)).filter(Boolean))];
      if (ids.length) {
        const found = await odoo.searchRead("res.partner", { domain: [["id", "in", ids]], fields: ["id", "ref", "email", "name"], limit: ids.length, context: { active_test: false } });
        for (const partner of found || []) partners[partner.id] = partner;
      }
    }
    for (const row of rows || []) {
      const at = timeMs(row.write_date);
      try {
        if (model.name === "res.partner") {
          const house = houseIdFromRef(row.ref);
          if (!house) { summary.skipped++; accepted.push(["res.partner", row]); continue; }
          const projection = contactProjection(row);
          const shadow = await loadShadow(store, "res.partner:" + row.id, "client:" + house);
          const decision = decideFields("contact", projection, shadow && shadow.data, at);
          if (decision.action !== "send") { summary.skipped++; accepted.push(["res.partner", row]); continue; }
          const version = shadow && shadow.data && shadow.data.version;
          outgoing.push({ change: contactChange(row, decision.fields, version), shadowId: "client:" + house, odooKey: "res.partner:" + row.id, projection, at: row.write_date, model: "res.partner" });
        } else if (model.name === "crm.lead") {
          const house = houseIdFromInquiry(row.description);
          if (!house) { summary.skipped++; accepted.push(["crm.lead", row]); continue; }
          const projection = leadProjection(row);
          const shadow = await loadShadow(store, "crm.lead:" + row.id, "inquiry:" + house);
          const decision = decideFields("inquiry", projection, shadow && shadow.data, at);
          if (decision.action === "baseline") {
            const data = shadow.data;
            data.fields = { ...data.fields, stage: { value: decision.stage, at: row.write_date } };
            data.fingerprint = fingerprint({ status: decision.status, stage: decision.stage });
            await saveShadow(store, ["inquiry:" + house, "crm.lead:" + row.id], data);
            summary.skipped++; accepted.push(["crm.lead", row]); continue;
          }
          if (decision.action !== "send") { summary.skipped++; accepted.push(["crm.lead", row]); continue; }
          const version = shadow && shadow.data && shadow.data.version;
          outgoing.push({ change: inquiryChange(row, decision.fields, version), shadowId: "inquiry:" + house, odooKey: "crm.lead:" + row.id, projection, at: row.write_date, model: "crm.lead" });
        } else {
          const partner = partners[m2o(row.partner_id)] || null;
          const projection = paymentProjection(row, partner);
          const fromMemo = houseIdFromMemo(row.memo);
          const shadow = await loadShadow(store, "account.payment:" + row.id, fromMemo ? "payment:" + fromMemo : "");
          const housePaymentId = fromMemo || (shadow && shadow.data && shadow.data.house_id) || "";
          if (looksShopify(row) || (shadow && shadow.data && shadow.data.blocked === "not_allowed")) {
            summary.skipped++; summary.errors.push({ at: now().toISOString(), odoo_id: row.id, kind: "payment", code: "not_allowed", error: "Shopify payments stay in the House. I did not send this one." });
            accepted.push(["account.payment", row]); continue;
          }
          if (!projection.client_id && !projection.email && !housePaymentId) {
            summary.failed++; summary.errors.push({ at: now().toISOString(), odoo_id: row.id, kind: "payment", error: "This payment has no House client id and no email, so I did not send it." });
            accepted.push(["account.payment", row]); continue;
          }
          const decision = decideFields("payment", projection, shadow && shadow.data, at);
          if (decision.action !== "send") { summary.skipped++; accepted.push(["account.payment", row]); continue; }
          if (!housePaymentId && projection.status === "voided") { summary.skipped++; accepted.push(["account.payment", row]); continue; }
          const today = now().toISOString().slice(0, 10);
          if (!housePaymentId && projection.date > today) {
            summary.failed++; summary.errors.push({ at: now().toISOString(), odoo_id: row.id, kind: "payment", error: "The payment date is in the future, so I did not send it yet." });
            break;
          }
          const version = shadow && shadow.data && shadow.data.version;
          const sentFields = housePaymentId ? decision.fields : projection;
          if (!housePaymentId && !(Number(projection.amount) > 0)) {
            summary.failed++; summary.errors.push({ at: now().toISOString(), odoo_id: row.id, kind: "payment", error: "The amount is not a positive number, so I did not send this payment." });
            accepted.push(["account.payment", row]); continue;
          }
          const change = paymentChange(row, sentFields, housePaymentId, version);
          if (!change) { summary.skipped++; accepted.push(["account.payment", row]); continue; }
          outgoing.push({ change, shadowId: housePaymentId ? "payment:" + housePaymentId : "account.payment:" + row.id, odooKey: "account.payment:" + row.id, projection, at: row.write_date, model: "account.payment" });
        }
      } catch (e) {
        summary.failed++; summary.errors.push({ at: now().toISOString(), odoo_id: row.id, kind: model.name, error: String(e.message || e).slice(0, 300) });
      }
    }
  }

  summary.preview = outgoing.map((item) => ({ ref: item.change.ref, type: item.change.type, house_id: item.change.house_id || "", odoo_id: Number(String(item.change.ref).split("/")[1]) || null }));
  if (!outgoing.length) {
    await advance(store, cursor, accepted);
    log("ROYAL: reverse sync sent 0.");
    return summary;
  }
  /* The House has no dry run. This switch only logs, and does not post. */
  if (dryRun) {
    log("ROYAL: reverse sync dry run would send " + outgoing.length + ".");
    return summary;
  }
  let pushed = await pushChanges(post, outgoing.map((item) => item.change), { sleep, maxRetries });
  let byRef = new Map(pushed.results.map((row) => [row.ref, row]));
  const conflicts = outgoing.filter((item) => {
    const result = byRef.get(item.change.ref);
    return result && result.code === "conflict" && item.change.type !== "payment.create";
  });
  if (conflicts.length && onConflict) {
    await onConflict(conflicts.map((item) => byRef.get(item.change.ref)));
    const again = [];
    for (const item of conflicts) {
      const shadow = await loadShadow(store, item.odooKey, item.shadowId);
      const version = shadow && shadow.data && shadow.data.version;
      if (!Number.isFinite(version) || version === item.change.if_version) continue;
      again.push({ ...item.change, if_version: version });
      item.resent = true;
    }
    if (again.length) {
      const second = await pushChanges(post, again, { sleep, maxRetries });
      for (const row of second.results) byRef.set(row.ref, row);
    }
  }
  for (const item of outgoing) {
    const result = byRef.get(item.change.ref);
    const code = result && result.code;
    if (code === "not_allowed") {
      summary.skipped++;
      summary.errors.push({ at: now().toISOString(), ref: item.change.ref, type: item.change.type, code, error: "The dashboard refused this payment (Shopify or a key that needs saving). I will not keep retrying it." });
      await saveShadow(store, [item.odooKey, item.shadowId], { ...(await shadowData(store, item)), blocked: "not_allowed", fingerprint: fingerprint(item.projection) });
      accepted.push([item.model, { id: odooIdOf(item.change.ref), write_date: item.at }]);
      continue;
    }
    if (!result || !result.ok) {
      summary.held++; summary.failed++;
      summary.errors.push({ at: now().toISOString(), ref: item.change.ref, type: item.change.type, code: code || "", error: (result && result.error) || "The dashboard did not accept this change." });
      continue;
    }
    summary.sent++;
    const houseId = result.house_id || item.change.house_id || "";
    let fields = item.projection;
    if (item.change.type === "payment.create" && houseId && odoo.write) {
      const memo = ("RT:" + houseId + " " + text(item.projection.memo)).trim().slice(0, 250);
      try { await odoo.write("account.payment", [odooIdOf(item.change.ref)], { memo }); fields = { ...fields, memo }; }
      catch (e) { summary.errors.push({ at: now().toISOString(), ref: item.change.ref, type: item.change.type, error: "I saved the payment but could not mark it in Odoo. " + String(e.message || e).slice(0, 200) }); }
    }
    const data = {
      kind: item.change.type.startsWith("contact") ? "contact" : item.change.type.startsWith("inquiry") ? "inquiry" : "payment",
      house_id: houseId, fingerprint: fingerprint(fields), fields: shadowFields(fields, item.at), dashboard: shadowFields(fields, item.at),
      stage_baseline: false, at: item.at, version: result.version, house_key: item.shadowId,
    };
    const keys = [item.odooKey, item.shadowId];
    if (houseId && data.kind === "payment") keys.push("payment:" + houseId);
    await saveShadow(store, keys, data);
    accepted.push([item.model, { id: odooIdOf(item.change.ref), write_date: item.at }]);
  }
  await advance(store, cursor, accepted);
  log("ROYAL: reverse sync sent " + summary.sent + ", held " + summary.held + ".");
  return summary;
}

function odooIdOf(ref) {
  const n = Number(String(ref || "").split("/")[1]);
  return Number.isFinite(n) ? n : null;
}

async function shadowData(store, item) {
  const row = await loadShadow(store, item.odooKey, item.shadowId);
  return (row && row.data) || {};
}

async function advance(store, cursor, accepted) {
  for (const [model, row] of accepted) {
    const cur = cursor[model] || { write_date: "", id: 0 };
    const nextDate = text(row.write_date);
    if (!cur.write_date || nextDate > cur.write_date || (nextDate === cur.write_date && row.id > (cur.id || 0))) cursor[model] = { write_date: nextDate, id: row.id };
  }
  await cas(store, REVERSE_KIND, REVERSE_ID, () => cursor);
}
