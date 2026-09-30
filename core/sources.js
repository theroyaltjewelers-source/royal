/* Where each kind of fact comes from, how fresh it has to be, and what
   happens when two sources disagree.  ROYAL reasons over these facts; it
   never stores its own opinion of them as if it were one. */

import { EVIDENCE as E, FRESHNESS as F, CONNECTION } from "./enums.js";
import { deepFreeze, stableHash } from "./util.js";

const MIN = 60000, HOUR = 60 * MIN;

export const SOURCE_REGISTRY = deepFreeze({
  PROJECT_STATUS:  { authoritative: "calculator", fallback: null, adapter: "royal_t.calculator", current: 15 * MIN, recent: 6 * HOUR,
                     verification: "Read from the calculator's own project records through its House API." },
  CLIENT:          { authoritative: "calculator", fallback: "jewel360", adapter: "royal_t.calculator", current: HOUR, recent: 24 * HOUR,
                     verification: "Calculator client record by ID. Jewel360 is not connected; a mismatch would raise SOURCE_CONFLICT." },
  PRODUCTION:      { authoritative: "calculator", fallback: "vendor_report", adapter: "royal_t.calculator", current: 15 * MIN, recent: 6 * HOUR,
                     verification: "Stage and manufacturer payments from the calculator. Vendor statements are REPORTED_UNVERIFIED." },
  PAYMENT:         { authoritative: "calculator", fallback: "quickbooks", adapter: "royal_t.calculator", current: 15 * MIN, recent: 6 * HOUR,
                     verification: "Live (non-voided) payments recorded in the calculator. Bank confirmation is not connected, so payments are recorded, not bank-verified." },
  RECEIVABLE:      { authoritative: "calculator", fallback: null, adapter: "royal_t.calculator", current: 15 * MIN, recent: 6 * HOUR,
                     verification: "Project value less live payments, computed by the calculator's own functions." },
  TREASURY:        { authoritative: "calculator", fallback: null, adapter: "royal_t.calculator", current: HOUR, recent: 24 * HOUR,
                     verification: "The calculator's Treasury: bills, debts, capital, runway." },
  APPOINTMENT:     { authoritative: null, fallback: null, adapter: null, current: 15 * MIN, recent: 6 * HOUR,
                     verification: "No calendar is connected." },
  SALES_PIPELINE:  { authoritative: "calculator", fallback: "jewel360", adapter: "royal_t.calculator", current: HOUR, recent: 24 * HOUR,
                     verification: "Projects at Inquiry stage stand in for the pipeline until a CRM is connected." },
  POLICY:          { authoritative: "royal.docs", fallback: null, adapter: "royal.knowledge", current: Infinity, recent: Infinity,
                     verification: "Versioned policy manual. Only ACTIVE policies bind." },
  COMMITMENT:      { authoritative: "royal.store", fallback: "calculator", adapter: "royal.commitments", current: 15 * MIN, recent: 6 * HOUR,
                     verification: "Recorded commitments, plus target dates from the calculator treated as commitments to the client." },
  VENDOR:          { authoritative: "calculator", fallback: null, adapter: "royal_t.calculator", current: HOUR, recent: 24 * HOUR,
                     verification: "Treasury vendor directory." },
  SOFTWARE_STATUS: { authoritative: "royal.health", fallback: null, adapter: "royal.forge", current: 5 * MIN, recent: HOUR,
                     verification: "Connector heartbeats and ingest results." },
});

export function freshness(domain, verifiedAt, now = Date.now()) {
  const s = SOURCE_REGISTRY[domain];
  if (!s || !verifiedAt) return F.UNKNOWN;
  const age = now - verifiedAt;
  if (age < 0) return F.CURRENT;
  if (age <= s.current) return F.CURRENT;
  if (age <= s.recent) return F.RECENT;
  return F.STALE;
}

export function ageText(verifiedAt, now = Date.now()) {
  if (!verifiedAt) return "never verified";
  const m = Math.round((now - verifiedAt) / MIN);
  if (m < 1) return "verified just now";
  if (m < 60) return "verified " + m + " minute" + (m === 1 ? "" : "s") + " ago";
  const h = Math.round(m / 60);
  if (h < 48) return "verified " + h + " hour" + (h === 1 ? "" : "s") + " ago";
  return "verified " + Math.round(h / 24) + " days ago";
}

/* A labelled fact.  Inference and verified state are never the same shape of
   object with a different colour: the label travels with the value. */
export function fact(value, { label = E.VERIFIED, source = null, domain = null, verified_at = null, note = null } = {}) {
  if (!E[label]) throw new Error("FACT_INVALID: unknown evidence label " + label);
  return { value, label, source, domain, verified_at, note };
}

/* Two sources disagree.  ROYAL does not choose; it reports both. */
export function sourceConflict(domain, entity, a, b) {
  return {
    kind: "SOURCE_CONFLICT", domain, entity,
    id: "conf_" + stableHash({ domain, entity, a: a.value, b: b.value }),
    values: [a, b],
    summary: domain + " for " + entity + " differs: " + a.source + " says " + JSON.stringify(a.value) + ", " + b.source + " says " + JSON.stringify(b.value) + ".",
  };
}

/* The connection state of each source, maintained by connectors. */
export class SourceHealth {
  constructor() { this.state = new Map(); }
  set(source, status, detail = {}) { this.state.set(source, { source, status, at: Date.now(), ...detail }); }
  get(source) { return this.state.get(source) || { source, status: CONNECTION.NOT_CONNECTED }; }
  all() { return Array.from(this.state.values()); }
}
