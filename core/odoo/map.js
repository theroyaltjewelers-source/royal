/* House feed envelopes -> Odoo 19/20 standard fields.
   No Studio and no custom fields. House ids live in fields Odoo already has:
   res.partner.ref ("RT:<client_id>"), account.payment.memo (contains
   "RT:<payment_id>" or "RT:<refund_id>"), and the first line of crm.lead
   description ("House inquiry RT:<inquiry_id>"). ROYAL's store remembers the
   Odoo id too; the field is how a lost store finds the same record again.
   Nothing here deletes a record. */

const ARCHIVED = { active_test: false };

function text(v) {
  if (v == null) return "";
  return String(v).trim();
}
function defined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}
function explicitName(d) {
  return text(d.name) || [d.first_name, d.last_name].map(text).filter(Boolean).join(" ");
}
function personName(d, fallback) {
  return explicitName(d) || text(d.client_name) || text(d.customer_name) || text(d.email) || fallback || "House contact";
}
function emailOf(v) {
  const s = text(v);
  return s.includes("@") ? s : "";
}
function locationText(loc) {
  if (!loc) return "";
  if (typeof loc === "string") return text(loc);
  return text(loc.text) || [loc.city, loc.region, loc.country].map(text).filter(Boolean).join(", ");
}
function splitAddress(address) {
  const a = text(address);
  if (!a) return {};
  return { street: a.slice(0, 128), street2: a.length > 128 ? a.slice(128, 256) : undefined, overflow: a.length > 256 ? a : "" };
}

export function partnerRef(clientId) { return "RT:" + text(clientId); }
export function inquiryMarker(inquiryId) { return "House inquiry RT:" + text(inquiryId); }
export function paymentTag(id) { return "RT:" + text(id); }

export function taggedMemo(id, extra) {
  const tag = paymentTag(id);
  const rest = text(extra);
  if (!rest) return tag.slice(0, 250);
  if (rest.startsWith(tag + " ") || rest === tag) return rest.slice(0, 250);
  return (tag + " " + rest).slice(0, 250);
}

/* The tag is a whole token, so a shorter id cannot match a longer one. */
export function memoHasTag(memo, id) {
  const tag = paymentTag(id);
  const s = text(memo);
  if (!s || !tag) return false;
  let from = 0;
  while (from <= s.length) {
    const i = s.indexOf(tag, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : s.charAt(i - 1);
    const after = s.charAt(i + tag.length);
    if ((i === 0 || before === " ") && (after === "" || after === " ")) return true;
    from = i + 1;
  }
  return false;
}

const COMMENT_MARK = "House record:";
export function houseComment(clientId, data, overflowAddress) {
  const lines = [COMMENT_MARK + " RT:" + text(clientId)];
  if (text(data.instagram)) lines.push("Instagram: " + text(data.instagram));
  if (text(data.source)) lines.push("Source: " + text(data.source));
  if (overflowAddress) lines.push("Address: " + overflowAddress);
  if (text(data.dashboard_link)) lines.push("Dashboard: " + text(data.dashboard_link));
  return lines.join("\n").slice(0, 2000);
}
export function mergeComment(existing, block) {
  const cur = text(existing);
  const i = cur.indexOf(COMMENT_MARK);
  if (i < 0) return (cur ? cur + "\n\n" : "") + block;
  const head = cur.slice(0, i).trimEnd();
  return (head ? head + "\n\n" : "") + block;
}

export function leadTitle(d) {
  const piece = text(d.piece_name) || text(d.piece_type) || "Inquiry";
  const customer = text(d.customer_name) || explicitName(d) || "Customer";
  return (piece + " - " + customer).slice(0, 240);
}

export function inquiryDescription(d) {
  const rows = [
    ["Status", d.status], ["Kind", d.kind], ["Piece", d.piece_name], ["Piece type", d.piece_type],
    ["Reference", d.piece_reference], ["Piece URL", d.piece_url], ["Metal", d.metal], ["Stones", d.stones],
    ["Consultation", d.consultation_type], ["Wanted by", d.wanted_by], ["Budget", d.budget], ["Timing", d.timing],
    ["Sizing", d.sizing], ["Location", locationText(d.location)], ["Contact preference", d.contact_preference],
    ["How they found us", d.how_they_found_us], ["Submitted", d.submitted_at], ["Message", d.message],
    ["Dashboard", d.dashboard_link], ["Client", d.client_id], ["Email", d.email], ["Phone", d.phone],
  ];
  const body = rows.filter(([, v]) => text(v)).map(([k, v]) => k + ": " + text(v)).join("\n");
  return (inquiryMarker(d.inquiry_id) + (body ? "\n" + body : "")).slice(0, 8000);
}

export function moneyCents(v) {
  const s = typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : text(v);
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error("The amount is not a number, so I did not record this payment.");
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error("The amount is not a number, so I did not record this payment.");
  return Math.round(n * 100);
}
export function day(v) {
  const s = text(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error("The date is missing, so I did not record this payment.");
  return s;
}

function rowId(row) {
  if (!row) return null;
  return typeof row.id === "number" ? row.id : (Array.isArray(row.id) ? row.id[0] : null);
}

async function readOne(odoo, model, id, fields) {
  if (!id) return null;
  try {
    const rows = await odoo.read(model, [id], fields, ARCHIVED);
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (e) {
    if (/does not exist|missing error|not exist/i.test(e.message || "")) return null;
    throw e;
  }
}

function pickPartner(rows, ourRef) {
  const list = (rows || []).filter((r) => rowId(r)).slice().sort((a, b) => rowId(a) - rowId(b));
  if (ourRef) {
    const ours = list.find((r) => text(r.ref) === ourRef);
    if (ours) return ours;
  }
  return list[0] || null;
}

async function searchPartners(odoo, domain) {
  return odoo.searchRead("res.partner", {
    domain, fields: ["id", "name", "email", "phone", "street", "street2", "ref", "comment", "customer_rank", "active"],
    limit: 5, order: "id", context: ARCHIVED,
  });
}

function partnerCache(cache) {
  if (!cache) return null;
  if (!cache.partners) cache.partners = new Map();
  return cache.partners;
}
function cachedPartner(bag, keys) {
  if (!bag) return null;
  for (const key of keys) {
    if (key && bag.has(key)) return bag.get(key);
  }
  return null;
}
function rememberPartner(bag, keys, id) {
  if (!bag || !id) return id;
  for (const key of keys) if (key) bag.set(key, id);
  return id;
}

/* Find a contact by the House client id (ref), then by email, then by phone.
   Match an existing email before creating. Never unlink. Lookups from one
   pass are reused, so a page of payments for the same client does not search
   res.partner again. */
export async function findOrCreatePartner(odoo, data, { create = true, fillExisting = true, cache } = {}) {
  const clientId = text(data.client_id);
  const ourRef = clientId ? partnerRef(clientId) : "";
  const email = emailOf(data.email);
  const phone = text(data.phone);
  const bag = partnerCache(cache);
  const keys = [ourRef && "ref:" + ourRef, email && "email:" + email.toLowerCase(), phone && "phone:" + phone];
  const hit = cachedPartner(bag, keys);
  /* A payment or inquiry only needs the id. A client update must still write. */
  if (hit && !fillExisting) return hit;
  let row = null;
  if (ourRef) {
    const byRef = await searchPartners(odoo, [["ref", "=", ourRef]]);
    row = pickPartner(byRef, ourRef);
  }
  if (!row && email) row = pickPartner(await searchPartners(odoo, [["email", "=ilike", email]]), ourRef);
  if (!row && phone) row = pickPartner(await searchPartners(odoo, [["phone", "=ilike", phone]]), ourRef);
  const addr = splitAddress(data.address);
  const comment = clientId ? houseComment(clientId, data, addr.overflow) : "";
  const name = explicitName(data) || text(data.client_name) || text(data.customer_name);
  if (row) {
    if (!fillExisting) {
      if (ourRef && !text(row.ref)) await odoo.write("res.partner", [rowId(row)], { ref: ourRef }, ARCHIVED);
      return rememberPartner(bag, keys, rowId(row));
    }
    const rank = Math.max(1, Number(row.customer_rank) || 0);
    const vals = defined({
      name: name || undefined,
      email: email || undefined,
      phone: phone || undefined,
      street: addr.street || undefined,
      street2: addr.street2,
      customer_rank: rank,
      comment: comment ? mergeComment(row.comment, comment) : undefined,
      active: data.archived === true ? false : data.archived === false ? true : undefined,
      ref: ourRef && (!text(row.ref) || text(row.ref) === ourRef) ? ourRef : undefined,
    });
    if (Object.keys(vals).length) await odoo.write("res.partner", [rowId(row)], vals, ARCHIVED);
    return rememberPartner(bag, keys, rowId(row));
  }
  if (!create) return null;
  const id = await odoo.create("res.partner", defined({
    name: personName(data),
    email: email || undefined,
    phone: phone || undefined,
    street: addr.street || undefined,
    street2: addr.street2,
    ref: ourRef || undefined,
    customer_rank: 1,
    comment: comment || undefined,
    active: data.archived === true ? false : true,
    is_company: false,
  }));
  return rememberPartner(bag, keys, id);
}

function leadBucket(row) {
  if (!row) return "open";
  if (row.won_status === "won") return "won";
  if (row.won_status === "lost") return "lost";
  if (Number(row.probability) === 100 && row.active !== false) return "won";
  if (row.active === false) return "lost";
  return "open";
}
function wantedBucket(status) {
  if (status === "converted") return "won";
  if (status === "closed") return "lost";
  return "open";
}

async function syncLeadState(odoo, leadId, status) {
  const row = await readOne(odoo, "crm.lead", leadId, ["id", "active", "probability", "won_status"]);
  const have = leadBucket(row);
  const want = wantedBucket(text(status));
  if (have === want) return have;
  if (want === "won") await odoo.exec("crm.lead", "action_set_won", [leadId]);
  else if (want === "lost") await odoo.exec("crm.lead", "action_set_lost", [leadId]);
  else if (have === "lost") await odoo.exec("crm.lead", "action_restore", [leadId]);
  else {
    const stages = await odoo.searchRead("crm.stage", {
      domain: [["is_won", "=", false]], fields: ["id"], order: "sequence,id", limit: 1,
    });
    const stage = stages && stages[0];
    if (!stage || !rowId(stage)) throw new Error("I could not find an open CRM stage to move this inquiry back to.");
    await odoo.write("crm.lead", [leadId], { stage_id: rowId(stage), probability: 10, active: true });
  }
  return want;
}

async function findLead(odoo, inquiryId, mappedId) {
  const mapped = await readOne(odoo, "crm.lead", mappedId, ["id", "active", "probability", "won_status", "description"]);
  if (mapped) return mapped;
  const rows = await odoo.searchRead("crm.lead", {
    domain: [["description", "ilike", inquiryMarker(inquiryId)]],
    fields: ["id", "active", "probability", "won_status", "description"],
    limit: 5, order: "id", context: ARCHIVED,
  });
  return (rows || []).find((r) => text(r.description).includes(inquiryMarker(inquiryId))) || null;
}

async function upsertLead(odoo, data, mappedId, cache) {
  const inquiryId = text(data.inquiry_id);
  if (!inquiryId) throw new Error("The inquiry has no inquiry_id.");
  const partnerId = await findOrCreatePartner(odoo, {
    client_id: data.client_id, name: text(data.customer_name) || explicitName(data),
    first_name: data.first_name, last_name: data.last_name, email: data.email, phone: data.phone,
  }, { fillExisting: !text(data.client_id), cache });
  const vals = defined({
    name: leadTitle(data),
    partner_id: partnerId || undefined,
    contact_name: text(data.customer_name) || explicitName(data) || undefined,
    email_from: emailOf(data.email) || undefined,
    phone: text(data.phone) || undefined,
    description: inquiryDescription(data),
  });
  let id = rowId(await findLead(odoo, inquiryId, mappedId));
  if (id) await odoo.write("crm.lead", [id], vals, ARCHIVED);
  else id = await odoo.create("crm.lead", { ...vals, type: "lead" });
  await syncLeadState(odoo, id, data.status);
  return id;
}

function journalMethodId(row, direction) {
  const key = direction === "outbound" ? "outbound_payment_method_line_ids" : "inbound_payment_method_line_ids";
  const raw = row ? row[key] : null;
  if (!Array.isArray(raw) || !raw.length) return null;
  const first = raw[0];
  if (typeof first === "number") return first;
  if (Array.isArray(first)) return first[0];
  if (first && typeof first.id === "number") return first.id;
  return null;
}

async function journalRows(odoo, domain, withMethods) {
  const fields = withMethods
    ? ["id", "name", "inbound_payment_method_line_ids", "outbound_payment_method_line_ids"]
    : ["id", "name"];
  return odoo.searchRead("account.journal", { domain, fields, limit: 1, order: "sequence,id" });
}

export async function resolveJournal(odoo, cache, cfg, direction) {
  const slot = direction === "outbound" ? "outbound" : "inbound";
  if (cache[slot]) return cache[slot];
  const domain = cfg.journalId ? [["id", "=", cfg.journalId]] : [["type", "=", "bank"]];
  let rows;
  try { rows = await journalRows(odoo, domain, true); }
  catch (e) {
    if (!/invalid field|unknown field|does not exist/i.test(e.message || "")) throw e;
    rows = await journalRows(odoo, domain, false);
  }
  if ((!rows || !rows.length) && !cfg.journalId) {
    try { rows = await journalRows(odoo, [["type", "=", "cash"]], true); }
    catch (_) { rows = await journalRows(odoo, [["type", "=", "cash"]], false); }
  }
  const row = rows && rows[0];
  if (!row || !rowId(row)) {
    throw new Error(cfg.journalId
      ? "ODOO_PAYMENT_JOURNAL_ID does not match a journal in Odoo."
      : "I could not find a bank or cash journal in Odoo. Set ODOO_PAYMENT_JOURNAL_ID.");
  }
  cache[slot] = { journalId: rowId(row), methodId: journalMethodId(row, direction) };
  return cache[slot];
}

async function currencyId(odoo, cache, code) {
  const c = (text(code) || "USD").toUpperCase();
  if (!cache.currency) cache.currency = new Map();
  if (cache.currency.has(c)) return cache.currency.get(c);
  const rows = await odoo.searchRead("res.currency", { domain: [["name", "=", c]], fields: ["id", "name"], limit: 1 });
  const id = rows && rows[0] && rowId(rows[0]);
  if (!id) throw new Error("I could not find the currency " + c + " in Odoo.");
  cache.currency.set(c, id);
  return id;
}

function paymentBucket(row) {
  const s = text(row && row.state);
  if (!s || s === "draft") return "draft";
  if (s === "cancel" || s === "canceled" || s === "cancelled") return "cancelled";
  if (s === "rejected") return "rejected";
  return "posted";
}

async function findPayment(odoo, tagId, mappedId) {
  const mapped = await readOne(odoo, "account.payment", mappedId, ["id", "state", "amount", "date", "memo", "partner_id", "payment_type"]);
  if (mapped) return mapped;
  const rows = await odoo.searchRead("account.payment", {
    domain: [["memo", "ilike", paymentTag(tagId)]],
    fields: ["id", "state", "amount", "date", "memo", "partner_id", "payment_type"],
    limit: 5, order: "id", context: ARCHIVED,
  });
  return (rows || []).find((r) => memoHasTag(r.memo, tagId)) || null;
}

async function resetToDraft(odoo, id) {
  try { await odoo.exec("account.payment", "action_draft", [id]); }
  catch (e) {
    throw new Error("I could not reset this posted payment to draft, so I left the amount and date unchanged. Odoo said: " + e.message);
  }
}

async function postPayment(odoo, id) {
  await odoo.exec("account.payment", "action_post", [id]);
}

async function upsertMoney(odoo, cache, cfg, spec) {
  const cents = moneyCents(spec.amount);
  if (cents < 0) throw new Error("The amount is negative, so I did not record this payment.");
  const date = day(spec.date);
  const amount = cents / 100;
  const partnerId = await findOrCreatePartner(odoo, spec.partner, { fillExisting: !text(spec.partner.client_id), cache });
  if (!partnerId) throw new Error("I could not find or create the Odoo contact for this payment.");
  const journal = await resolveJournal(odoo, cache, cfg, spec.direction);
  const currency = await currencyId(odoo, cache, spec.currency);
  const memo = taggedMemo(spec.tagId, spec.memoExtra);
  const vals = defined({
    payment_type: spec.direction,
    partner_type: "customer",
    partner_id: partnerId,
    amount, date, memo,
    journal_id: journal.journalId,
    payment_method_line_id: journal.methodId || undefined,
    currency_id: currency,
    payment_reference: text(spec.reference) || undefined,
  });
  const existing = await findPayment(odoo, spec.tagId, spec.mappedId);
  if (!existing) {
    const id = await odoo.create("account.payment", vals);
    await postPayment(odoo, id);
    return id;
  }
  const id = rowId(existing);
  const bucket = paymentBucket(existing);
  if (bucket === "rejected") throw new Error("This payment is rejected in Odoo, so I did not change it.");
  let sameAmount = false;
  try { sameAmount = moneyCents(existing.amount) === cents; } catch (_) { sameAmount = false; }
  const sameDate = text(existing.date).slice(0, 10) === date;
  if (bucket === "draft" || bucket === "cancelled") {
    if (bucket === "cancelled") await resetToDraft(odoo, id);
    await odoo.write("account.payment", [id], vals);
    await postPayment(odoo, id);
    return id;
  }
  if (sameAmount && sameDate) {
    if (text(existing.memo) !== memo) await odoo.write("account.payment", [id], { memo });
    return id;
  }
  await resetToDraft(odoo, id);
  await odoo.write("account.payment", [id], vals);
  await postPayment(odoo, id);
  return id;
}

async function voidPayment(odoo, data, mappedId) {
  const paymentId = text(data.payment_id);
  if (!paymentId) throw new Error("The voided payment has no payment_id.");
  const existing = await findPayment(odoo, paymentId, mappedId);
  if (!existing) throw new Error("I have no Odoo payment for House payment " + paymentId + " yet, so I could not cancel it.");
  const id = rowId(existing);
  if (paymentBucket(existing) === "cancelled") return id;
  try { await odoo.exec("account.payment", "action_cancel", [id]); }
  catch (e) { throw new Error("I could not cancel this payment in Odoo. Odoo said: " + e.message); }
  return id;
}

export async function applyHouseEvent(event, { odoo, cache, cfg, mappedId } = {}) {
  const data = (event && event.data) || {};
  const type = event.event_type;
  if (type === "client.created" || type === "client.updated") {
    if (!text(data.client_id)) throw new Error("The client has no client_id.");
    const id = await findOrCreatePartner(odoo, data, { fillExisting: true, cache });
    return { model: "res.partner", odoo_id: id };
  }
  if (type === "inquiry.created" || type === "inquiry.updated") {
    const id = await upsertLead(odoo, data, mappedId, cache);
    return { model: "crm.lead", odoo_id: id };
  }
  if (type === "payment.voided" || ((type === "payment.recorded" || type === "payment.updated") && data.status === "voided")) {
    const id = await voidPayment(odoo, data, mappedId);
    return { model: "account.payment", odoo_id: id };
  }
  if (type === "payment.recorded" || type === "payment.updated") {
    const id = await upsertMoney(odoo, cache, cfg, {
      tagId: data.payment_id, mappedId, direction: "inbound", amount: data.amount, date: data.date,
      currency: data.currency, reference: data.reference,
      memoExtra: [data.memo, data.reference, data.description].map(text).filter(Boolean).join(" "),
      partner: { client_id: data.client_id, name: data.client_name, email: data.email, phone: data.phone },
    });
    return { model: "account.payment", odoo_id: id };
  }
  if (type === "payment.refunded") {
    const payment = data.payment || {};
    const id = await upsertMoney(odoo, cache, cfg, {
      tagId: data.refund_id, mappedId, direction: "outbound", amount: data.refund_amount, date: data.refund_date,
      currency: payment.currency || data.currency, reference: payment.reference,
      memoExtra: "refund" + (text(payment.payment_id) ? " of RT:" + text(payment.payment_id) : ""),
      partner: { client_id: payment.client_id, name: payment.client_name, email: payment.email || data.email, phone: payment.phone },
    });
    return { model: "account.payment", odoo_id: id };
  }
  throw new Error("I don't recognise event type " + String(type || "") + ".");
}
