/* Professional contact research: a person's business email, responsibly.

   Order of discovery (each step only if configured and switched on):
     1 research memory (30 days)
     2 publicly listed on the company's own site: ROYAL fetches the page and
       finds the exact address in it                          PUBLICLY_LISTED
     3 Hunter Email Finder                                    PROVIDER_FOUND
     4 Apollo People Enrichment (business email only)          PROVIDER_FOUND
     5 the company's email pattern (Hunter Domain Search)      PATTERN_INFERRED
   then verification (Hunter Email Verifier), when switched on:
     valid -> VERIFIED_DELIVERABLE (LIKELY_DELIVERABLE for a pattern guess),
     invalid -> INVALID, accept_all on a pattern guess -> RISKY, unknown with
     a low score -> RISKY; otherwise the finding stays as found, with the
     verifier's state and reason alongside.  An address found on a page that
     is not the company's own is UNVERIFIED.

   PATTERN_INFERRED is never shown as verified.  Nothing is invented: with
   no provider and nothing public, the answer is NOT_FOUND.

   Privacy.  Only business addresses on the company's own domain.  Webmail
   and disposable addresses are discarded, Apollo is asked never to reveal
   personal emails, and no personal phone, home address or private record is
   ever sought.  Provider terms apply (Hunter returns 451 for people who asked
   not to be listed; ROYAL respects it and says so). */

import { EMAIL_STATUS as ES } from "../../enums.js";
import { sameSite, hostOf } from "../truth.js";

/* Personal mail services, matched as whole domains (so a business's own
   mail.acme.com is not mistaken for webmail). */
const WEBMAIL = /@(gmail\.com|googlemail\.com|(yahoo|hotmail|outlook|live|gmx|yandex)(\.[a-z]{2,3}){1,2}|ymail\.com|msn\.com|aol\.com|icloud\.com|me\.com|mac\.com|proton\.me|protonmail\.(com|ch)|pm\.me|mail\.com|zoho\.com)$/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

export function isBusinessEmail(email, domain) {
  const e = String(email || "").toLowerCase().trim();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return false;
  if (WEBMAIL.test(e)) return false;
  return !domain || sameSite(e.split("@")[1], domain);
}

/* {first}.{last} style patterns, as Hunter reports them. */
export function applyPattern(pattern, first, last, domain) {
  const f = String(first || "").toLowerCase().replace(/[^a-z]/g, ""), l = String(last || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!pattern || !f || !domain) return null;
  const local = pattern.replace(/\{first\}/g, f).replace(/\{last\}/g, l).replace(/\{f\}/g, f[0] || "").replace(/\{l\}/g, l[0] || "");
  if (/[{}]/.test(local) || !local) return null;
  return local + "@" + domain;
}

export function splitName(name) {
  const parts = String(name || "").trim().replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, "").split(/\s+/);
  return { first: parts[0] || "", last: parts.length > 1 ? parts[parts.length - 1] : "" };
}

/* --------------------------------------------------------- providers --- */

class Quota {
  constructor(perMinute, perDay) { this.perMinute = perMinute; this.perDay = perDay; this.calls = []; }
  take(now) { this.calls = this.calls.filter((t) => now - t < 86400000); const lastMin = this.calls.filter((t) => now - t < 60000).length;
    if (lastMin >= this.perMinute || this.calls.length >= this.perDay) return false; this.calls.push(now); return true; }
}

export class HunterProvider {
  constructor({ apiKey, fetchImpl = globalThis.fetch, clock = () => Date.now(), perDay = 200, metrics = null }) {
    this.id = "hunter"; this._key = apiKey || null; this.fetch = fetchImpl; this.clock = clock; this.metrics = metrics;
    this.quota = new Quota(60, perDay); this.lastError = null;
  }
  configured() { return !!this._key; }
  status() { return this._key ? { status: this.lastError ? "DEGRADED" : "CONNECTED", detail: this.lastError } : { status: "NOT_CONFIGURED", detail: "HUNTER_API_KEY is not set." }; }
  async _get(path, params) {
    if (!this._key) return { ok: false, failed_because: "NOT_CONFIGURED" };
    if (!this.quota.take(this.clock())) return { ok: false, failed_because: "QUOTA_EXCEEDED" };
    const u = new URL("https://api.hunter.io/v2/" + path);
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    const t0 = Date.now();
    try {
      const r = await this.fetch(u, { headers: { "X-API-KEY": this._key, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
      const j = await r.json().catch(() => null);
      if (this.metrics) this.metrics.observe("provider.hunter." + path, Date.now() - t0, { ok: r.ok });
      if (r.status === 451) return { ok: false, failed_because: "PERSON_ASKED_NOT_TO_BE_LISTED" };
      if (r.status === 202 || r.status === 222) return { ok: false, failed_because: "VERIFICATION_PENDING", retryable: true };
      if (r.status === 429) { this.lastError = "rate limited"; return { ok: false, failed_because: "PROVIDER_RATE_LIMITED", retryable: true }; }
      if (r.status === 401 || r.status === 403) { this.lastError = "invalid key"; return { ok: false, failed_because: "PROVIDER_AUTH_FAILED" }; }
      if (!r.ok) { this.lastError = "HTTP " + r.status; return { ok: false, failed_because: "PROVIDER_HTTP_" + r.status }; }
      this.lastError = null;
      return { ok: true, data: (j && j.data) || {} };
    } catch (e) { this.lastError = "network"; return { ok: false, failed_because: e.name === "TimeoutError" ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK", retryable: true }; }
  }
  async findEmail({ first, last, domain }) {
    const r = await this._get("email-finder", { domain, first_name: first, last_name: last });
    if (!r.ok) return r;
    if (!r.data.email) return { ok: true, email: null };
    return { ok: true, email: r.data.email, score: r.data.score, position: r.data.position || null, sources: (r.data.sources || []).map((s) => s.uri).filter(Boolean).slice(0, 5),
      provider_verification: r.data.verification && r.data.verification.status || null };
  }
  async domainPattern({ domain }) {
    const r = await this._get("domain-search", { domain, limit: "1" });
    if (!r.ok) return r;
    return { ok: true, pattern: r.data.pattern || null };
  }
  async verify(email) {
    const r = await this._get("email-verifier", { email });
    if (!r.ok) return r;
    return { ok: true, status: r.data.status || "unknown", score: r.data.score ?? null, checked_at: this.clock() };
  }
}

export class ApolloProvider {
  constructor({ apiKey, fetchImpl = globalThis.fetch, clock = () => Date.now(), perDay = 100, metrics = null }) {
    this.id = "apollo"; this._key = apiKey || null; this.fetch = fetchImpl; this.clock = clock; this.metrics = metrics; this.quota = new Quota(30, perDay); this.lastError = null;
  }
  configured() { return !!this._key; }
  status() { return this._key ? { status: this.lastError ? "DEGRADED" : "CONNECTED", detail: this.lastError } : { status: "NOT_CONFIGURED", detail: "APOLLO_API_KEY is not set." }; }
  async findEmail({ first, last, domain, company }) {
    if (!this._key) return { ok: false, failed_because: "NOT_CONFIGURED" };
    if (!this.quota.take(this.clock())) return { ok: false, failed_because: "QUOTA_EXCEEDED" };
    const t0 = Date.now();
    try {
      const r = await this.fetch("https://api.apollo.io/api/v1/people/match", { method: "POST", signal: AbortSignal.timeout(20000),
        headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": this._key },
        body: JSON.stringify({ first_name: first, last_name: last, domain, organization_name: company, reveal_personal_emails: false, reveal_phone_number: false }) });
      const j = await r.json().catch(() => null);
      if (this.metrics) this.metrics.observe("provider.apollo.match", Date.now() - t0, { ok: r.ok });
      if (r.status === 429) { this.lastError = "rate limited"; return { ok: false, failed_because: "PROVIDER_RATE_LIMITED", retryable: true }; }
      if (r.status === 401 || r.status === 403) { this.lastError = "invalid key"; return { ok: false, failed_because: "PROVIDER_AUTH_FAILED" }; }
      if (!r.ok) { this.lastError = "HTTP " + r.status; return { ok: false, failed_because: "PROVIDER_HTTP_" + r.status }; }
      this.lastError = null;
      const p = (j && j.person) || null;
      if (!p || !p.email) return { ok: true, email: null };
      return { ok: true, email: p.email, provider_verification: p.email_status || null, position: p.title || null };
    } catch (e) { this.lastError = "network"; return { ok: false, failed_because: "PROVIDER_NETWORK", retryable: true }; }
  }
}

/* ----------------------------------------------------------- research --- */

export class ContactResearch {
  constructor({ hunter = null, apollo = null, fetcher = null, research = null, store = null, flags = {}, clock = () => Date.now(), audit = null }) {
    Object.assign(this, { hunter, apollo, fetcher, research, store, flags, clock, audit });
  }

  status() {
    return {
      discovery: this.flags.email_discovery ? (this.hunter && this.hunter.configured() || this.apollo && this.apollo.configured() ? "CONNECTED" : "NOT_CONFIGURED") : "DISABLED",
      verification: this.flags.email_verification ? (this.hunter && this.hunter.configured() ? "CONNECTED" : "NOT_CONFIGURED") : "DISABLED",
      providers: { hunter: this.hunter ? this.hunter.status() : { status: "NOT_CONFIGURED" }, apollo: this.apollo ? this.apollo.status() : { status: "NOT_CONFIGURED" } },
      public_web: this.research && this.research.status().status === "CONNECTED" ? "CONNECTED" : "NOT_CONFIGURED",
    };
  }

  /* person: { person_id, name, company, domain } from ExecutiveResearch. */
  async businessEmail(person) {
    const now = this.clock();
    const key = "ctc_" + person.person_id;
    const notes = [], tried = [];
    if (this.store) {
      const hit = await this.store.get("contacts", key);
      if (hit && hit.data.expires_at > now) return { ...hit.data, from_cache: true };
    }
    if (!person.domain) return this._save(key, { status: ES.NOT_FOUND, email: null, notes: ["The company's official domain is not known, so no business address can be matched to it."], tried });
    const { first, last } = splitName(person.name);
    let found = null, optedOut = false;

    /* 2: publicly listed on the company's own pages. */
    if (this.research && this.research.status().status === "CONNECTED") {
      tried.push("public web");
      const r = await this.research.research("Is a business email address for " + person.name + " (" + (person.title || "") + " at " + person.company + ") published on " + person.domain + " or in an official company document? Give the exact address and the page.",
        { depth: "QUICK", officialDomain: person.domain, instructions: "Only report an address you saw written on a page. Only business addresses at " + person.domain + ". Never a personal address, phone number or home address." });
      if (r.ok) for (const c of r.claims) {
        const m = String(c.value).match(EMAIL_RE);
        if (!m) continue;
        const email = m[0].toLowerCase();
        if (!isBusinessEmail(email, person.domain)) continue;
        for (const s of c.sources) {
          if (!this.fetcher) break;
          const p = await this.fetcher.fetch(s.url);
          if (p.ok && p.text.toLowerCase().indexOf(email) >= 0) {
            /* Published on the company's own site is PUBLICLY_LISTED; anywhere
               else it is a report, not a listing, and stays UNVERIFIED. */
            const own = sameSite(hostOf(p.final_url || s.url), person.domain);
            found = own ? { email, status: ES.PUBLICLY_LISTED, source: s.url, found_by: "the company's own site (confirmed on the page by ROYAL)" }
              : { email, status: ES.UNVERIFIED, source: s.url, found_by: "a third-party page (" + hostOf(s.url) + "), not the company's own site" };
            break;
          }
        }
        if (found) break;
        notes.push("A public source mentioned " + email + ", but ROYAL could not find it written on the cited page, so it was not used.");
      }
    }

    /* 3, 4: licensed providers. */
    if (!found && this.flags.email_discovery) {
      for (const prov of [this.hunter, this.apollo]) {
        if (!prov || !prov.configured()) continue;
        tried.push(prov.id);
        const r = await prov.findEmail({ first, last, domain: person.domain, company: person.company });
        if (!r.ok) {
          if (r.failed_because === "PERSON_ASKED_NOT_TO_BE_LISTED") { optedOut = true; break; }
          notes.push(prov.id + ": " + r.failed_because.replace(/_/g, " ").toLowerCase() + "."); continue;
        }
        if (r.email && isBusinessEmail(r.email, person.domain)) { found = { email: r.email.toLowerCase(), status: ES.PROVIDER_FOUND, source: prov.id, found_by: prov.id, provider_score: r.score ?? null, provider_verification: r.provider_verification || null }; break; }
        if (r.email) notes.push(prov.id + " returned an address that is not a business address at " + person.domain + "; it was discarded.");
      }
    } else if (!found) notes.push("Email discovery providers are switched off (email_discovery).");

    /* A person who asked not to be listed is not looked up any other way:
       no pattern, no verification. */
    if (optedOut) return this._save(key, { status: ES.NOT_FOUND, email: null, opted_out: true, tried, person_id: person.person_id,
      notes: ["This person asked not to be listed by the contact provider. ROYAL respects that and does not guess an address."] });

    /* 5: the company's pattern, clearly an inference. */
    if (!found && this.flags.email_discovery && this.hunter && this.hunter.configured()) {
      const p = await this.hunter.domainPattern({ domain: person.domain });
      const guess = p.ok ? applyPattern(p.pattern, first, last, person.domain) : null;
      if (guess) found = { email: guess, status: ES.PATTERN_INFERRED, source: "hunter domain pattern " + p.pattern, found_by: "pattern" };
    }

    if (!found) return this._save(key, { status: ES.NOT_FOUND, email: null, notes, tried, person_id: person.person_id });

    /* Verification. */
    let verification = { state: "unverified", provider: null, checked_at: null, note: this.flags.email_verification ? "No verification provider is configured." : "Email verification is switched off (email_verification)." };
    if (this.flags.email_verification && this.hunter && this.hunter.configured()) {
      const v = await this.hunter.verify(found.email);
      if (v.ok) {
        const state = v.status === "valid" ? "deliverable" : v.status === "invalid" ? "invalid" : v.status === "accept_all" ? "accept_all" : v.status === "unknown" ? "unknown" : (v.status === "webmail" || v.status === "disposable") ? "not_business" : "unknown";
        verification = { state, provider: "hunter", checked_at: v.checked_at, score: v.score };
        if (state === "deliverable") found.status = found.status === ES.PATTERN_INFERRED ? ES.LIKELY_DELIVERABLE : ES.VERIFIED_DELIVERABLE;
        else if (state === "invalid") found.status = ES.INVALID;
        else if (state === "not_business") return this._save(key, { status: ES.NOT_FOUND, email: null, notes: notes.concat(["The only address found is not a business address."]), tried });
        else if (state === "accept_all") { verification.note = "The company's mail server accepts every address, so deliverability cannot be confirmed."; if (found.status === ES.PATTERN_INFERRED) found.status = ES.RISKY; }
        else { verification.note = "The verifier could not decide."; if (typeof v.score === "number" && v.score < 50) found.status = ES.RISKY; }
      } else verification = { state: "unverified", provider: "hunter", checked_at: null, note: "Verification failed: " + v.failed_because.replace(/_/g, " ").toLowerCase() + "." };
    }
    const rec = { ...found, verification, notes, tried, person_id: person.person_id, name: person.name, company: person.company, domain: person.domain, checked_at: now };
    if (this.audit) await this.audit.record({ actor: "royal", action: "CONTACT_RESEARCH", summary: "Business email for a researched person: " + rec.status, tool: "email_find", result: rec.status }).catch(() => {});
    return this._save(key, rec);
  }

  async _save(key, rec) {
    const now = this.clock();
    const data = { ...rec, expires_at: now + (rec.status === ES.NOT_FOUND ? 86400000 : 30 * 86400000) };
    if (this.store) { const cur = await this.store.get("contacts", key); await this.store.put("contacts", key, data, cur ? cur.rev : null); }
    return data;
  }
}
