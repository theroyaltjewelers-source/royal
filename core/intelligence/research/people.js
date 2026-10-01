/* Company and executive research: "Find me the CFO of Company X."

     1 resolve the company (exact identity, official domain; stop if ambiguous)
     2 search for the person who holds the role now, official pages first
     3 classify every candidate's title against the role asked for, in code:
       former, acting, interim, subsidiary, regional, "VP Finance" and
       "Controller" are never silently treated as "CFO"
     4 cross-check: fetch the official leadership page (or best source) and
       confirm the name and the title appear together
     5 return a PersonProfile with evidence, sources, freshness, confidence

   Interfaces, so a licensed data provider can be added behind them:
     CompanyResearchProvider.resolve(name) / PeopleResearchProvider.roleHolder(company, role)
   The public-web implementation below uses the Research Engine. */

import { EVIDENCE as E, CONFIDENCE as C } from "../../enums.js";
import { S } from "../jsonschema.js";
import { claim, sourceQuality, sameSite, hostOf, FRESHNESS_TTL } from "../truth.js";
import { textSupports } from "./engine.js";
import { stableHash } from "../../util.js";

const ROLES = {
  cfo: { name: "Chief Financial Officer", abbr: "CFO", re: /\b(chief financial officer|cfo)\b/i },
  ceo: { name: "Chief Executive Officer", abbr: "CEO", re: /\b(chief executive officer|ceo)\b/i },
  coo: { name: "Chief Operating Officer", abbr: "COO", re: /\b(chief operating officer|coo)\b/i },
  cto: { name: "Chief Technology Officer", abbr: "CTO", re: /\b(chief technology officer|cto)\b/i },
  cmo: { name: "Chief Marketing Officer", abbr: "CMO", re: /\b(chief marketing officer|cmo)\b/i },
  president: { name: "President", abbr: "President", re: /\bpresident\b/i },
  founder: { name: "Founder", abbr: "Founder", re: /\b(co-?)?founders?\b/i },
  owner: { name: "Owner", abbr: "Owner", re: /\bowner\b/i },
};
const RELATED = { cfo: /\b(vp|vice president|svp|evp|head|director)\b.*\bfinance\b|\bcontroller\b|\btreasurer\b|\bfinance director\b/i };

export function roleKey(text) {
  const t = String(text || "").toLowerCase();
  for (const [k, r] of Object.entries(ROLES)) if (r.re.test(t)) return k;
  return null;
}

/* How a found title relates to the role asked for.  Code, not the model. */
export function classifyTitle(title, key) {
  const t = String(title || "").toLowerCase(), r = ROLES[key];
  if (!r) return "unknown";
  const matches = r.re.test(t);
  if (/\b(former|ex-|previous(ly)?|retired|until 20\d\d|emeritus)\b/.test(t)) return matches ? "former" : "unrelated";
  if (matches && /\b(acting|interim)\b/.test(t)) return "acting";
  if (matches && /\b(deputy|assistant|associate)\b/.test(t)) return "deputy";
  if (matches && /\b(regional|region|emea|apac|americas|europe|asia|north america|latam|division|divisional|group cfo of|subsidiary)\b/.test(t)) return "regional_or_subsidiary";
  if (matches) return "exact";
  if (RELATED[key] && RELATED[key].test(t)) return "related_title";
  return "unrelated";
}
const MATCH_TEXT = { exact: "", acting: "acting, not permanent", deputy: "a deputy role, not the officer", regional_or_subsidiary: "a regional or subsidiary role, not the company's",
  former: "no longer in the role", related_title: "a related finance role, not the officer", unrelated: "a different role", unknown: "role unclear" };

export const COMPANY_SCHEMA = S.obj({
  query: S.str(200),
  matches: S.arr(S.obj({ name: S.str(200), official_domain: S.nstr(200), description: S.str(300), headquarters: S.nstr(120), source_urls: S.arr(S.str(600), 5) }), 5),
  is_ambiguous: S.bool(),
});
export const ROLE_SCHEMA = S.obj({
  company: S.str(200), official_domain: S.nstr(200),
  candidates: S.arr(S.obj({ name: S.str(160), title: S.str(200), is_current: S.bool(), since: S.nstr(40), source_urls: S.arr(S.str(600), 6) }), 6),
  unknowns: S.arr(S.str(300), 6),
});

/* The name and the role together: the role within a short distance of the
   name, and not qualified as former, interim or acting there.  A page that
   says "John Doe, CFO ... Jane Smith, former CFO" does not confirm Jane. */
const DISQUALIFY = /\b(former|formerly|ex-|previous|previously|retired|interim|acting|outgoing|until \d{4})\b/i;
export function nameWithRole(text, name, roleRe) {
  const t = String(text || ""), n = String(name || "").trim();
  if (!t || !n) return false;
  const low = t.toLowerCase(), needle = n.toLowerCase();
  const re = new RegExp(roleRe.source, roleRe.flags.replace("g", ""));
  for (let i = low.indexOf(needle); i >= 0; i = low.indexOf(needle, i + needle.length)) {
    const after = t.slice(i + n.length, i + n.length + 120), before = t.slice(Math.max(0, i - 80), i);
    const m = re.exec(after);
    if (m && !DISQUALIFY.test(after.slice(0, m.index + m[0].length))) {
      const between = after.slice(0, m.index);
      if (!/[.;\n]\s*[A-Z][a-z]+\s+[A-Z][a-z]+/.test(between)) return true;   /* not another person's title */
    }
    /* "Our CFO, Jane Smith": the role right before the name, same sentence. */
    const tail = before.slice(Math.max(0, before.search(/[^.;\n]*$/)));
    const mb = re.exec(tail);
    if (mb && !DISQUALIFY.test(tail) && !/[A-Z][a-z]+\s+[A-Z][a-z]+/.test(tail.slice(mb.index + mb[0].length))) return true;
  }
  return false;
}

export class ExecutiveResearch {
  constructor({ research, fetcher = null, store = null, clock = () => Date.now() }) { Object.assign(this, { research, fetcher, store, clock }); }

  async resolveCompany(name, { depth = "QUICK" } = {}) {
    const r = await this.research.research("Identify the company named \"" + name + "\": its exact legal or trading name and its official website domain. If several companies share this name, list each.",
      { depth, schema: COMPANY_SCHEMA, instructions: "List every distinct company the name could mean. official_domain is the bare domain of the company's own website, for example example.com." });
    if (!r.ok) return r;
    const s = r.structured[0] || { matches: [] };
    const seen = new Set(r.sources.map((x) => x.url));
    /* A company counts only with a source the search provider reported, and
       its "official" domain only when one of those sources is on it: the
       domain decides which sources rank as official and which email
       addresses count as business addresses, so it is never taken on the
       model's word. */
    const bare = (d) => (d ? String(d).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase() : null);
    const matches = (s.matches || []).map((m) => {
      const source_urls = (m.source_urls || []).filter((u) => seen.has(u));
      const dom = bare(m.official_domain);
      return { ...m, source_urls, official_domain: dom && source_urls.some((u) => sameSite(hostOf(u), dom)) ? dom : null, claimed_domain: dom };
    }).filter((m) => m.source_urls.length);
    if (!matches.length) return { ok: true, status: "NOT_FOUND", query: name, report: r };
    /* More than one distinct company: ask, never pick. */
    const distinct = new Set(matches.map((m) => m.official_domain || m.claimed_domain || m.name.toLowerCase()));
    if (distinct.size > 1) return { ok: true, status: "AMBIGUOUS", query: name, candidates: matches, report: r };
    const m = matches[0];
    const company_id = "co_" + stableHash([(m.official_domain || m.name).toLowerCase()]);
    return { ok: true, status: "RESOLVED", company: { company_id, name: m.name, domain: m.official_domain || null, domain_unconfirmed: m.official_domain ? null : m.claimed_domain || null,
      description: m.description, headquarters: m.headquarters, sources: m.source_urls.map((u) => ({ url: u, quality: sourceQuality(u, { officialDomain: m.official_domain }) })) }, report: r };
  }

  /* Who holds `role` at `companyName` now. */
  async roleHolder(companyName, roleText, { depth = "STANDARD", company = null } = {}) {
    const key = roleKey(roleText) || "cfo";
    const role = ROLES[key];
    let co = company;
    if (!co) {
      const rc = await this.resolveCompany(companyName);
      if (!rc.ok) return rc;
      if (rc.status !== "RESOLVED") return rc;
      co = rc.company;
    }
    const today = new Date(this.clock()).toISOString().slice(0, 10);
    const r = await this.research.research("Who is the current " + role.name + " (" + role.abbr + ") of " + co.name + (co.domain ? " (" + co.domain + ")" : "") + " as of " + today + "? Check the company's own leadership or investor-relations page first, then recent filings or reputable news.",
      { depth, officialDomain: co.domain, schema: ROLE_SCHEMA, freshness: "current_role",
        instructions: "List each person found with the exact title the source uses. Set is_current false for anyone who has left the role. Include acting, interim, regional or subsidiary titles exactly as written; do not shorten them." });
    if (!r.ok) return r;
    const s = r.structured[0] || { candidates: [] };
    const byUrl = new Map(r.sources.map((x) => [x.url, x]));
    const candidates = (s.candidates || []).map((c) => {
      const sources = (c.source_urls || []).map((u) => byUrl.get(u)).filter(Boolean).map((x) => ({ ...x, quality: sourceQuality(x.url, { officialDomain: co.domain }) }));
      const match = c.is_current === false ? "former" : classifyTitle(c.title, key);
      return { name: c.name, title: c.title, is_current: c.is_current, since: c.since, match, match_note: MATCH_TEXT[match], sources };
    }).filter((c) => c.sources.length);

    const exact = candidates.filter((c) => c.match === "exact");
    const names = [...new Set(exact.map((c) => c.name.toLowerCase()))];
    const out = { ok: true, company: co, role: { key, name: role.name, abbr: role.abbr }, candidates, report_id: r.id, sources: r.sources, retrieved_at: r.retrieved_at,
      expires_at: r.retrieved_at + FRESHNESS_TTL.current_role, unknowns: (s.unknowns || []).slice(0, 6), conflict: null, person: null, claims: [] };
    if (names.length > 1) {
      out.status = "CONFLICT";
      out.conflict = { kind: "SOURCE_CONFLICT", summary: "Sources name different people as " + role.abbr + " of " + co.name + ": " + exact.map((c) => c.name + " (" + c.sources.map((x) => hostOf(x.url)).join(", ") + ")").join(" vs ") + "." };
      return out;
    }
    if (!exact.length) { out.status = candidates.length ? "ONLY_RELATED_ROLES" : "NOT_FOUND"; return out; }

    /* Cross-check the name and title together on the best source. */
    const pick = exact[0];
    let confirmed = null;
    for (const src of pick.sources.slice().sort((a, b) => b.quality.score - a.quality.score).slice(0, 3)) {
      if (!this.fetcher) break;
      const p = await this.fetcher.fetch(src.url);
      if (p.ok && nameWithRole(p.text, pick.name, role.re)) { confirmed = src; break; }
    }
    const official = confirmed && confirmed.quality.kind === "official";
    const strong = confirmed && confirmed.quality.score >= 4;
    const distinct = new Set(pick.sources.map((x) => hostOf(x.url))).size;
    const label = strong ? E.VERIFIED_EXTERNAL : E.REPORTED_UNVERIFIED;
    const confidence = official ? C.HIGH : strong ? (distinct >= 2 ? C.HIGH : C.MEDIUM) : distinct >= 2 ? C.MEDIUM : C.LOW;
    const person_id = "pe_" + stableHash([pick.name.toLowerCase(), co.company_id]);
    out.status = "FOUND";
    out.person = { person_id, name: pick.name, title: pick.title, company: co.name, company_id: co.company_id, domain: co.domain, since: pick.since || null,
      identity_confidence: confidence, role_confidence: confidence, label, cross_checked: !!confirmed, confirmed_on: confirmed ? confirmed.url : null, sources: pick.sources };
    out.claims = [claim({ subject: pick.name, predicate: role.abbr + " of " + co.name, value: pick.name + ", " + pick.title, label, sources: pick.sources,
      retrieved_at: r.retrieved_at, confidence, cross_checked: !!confirmed, freshness_class: "current_role",
      notes: confirmed ? "Name and title found together on " + hostOf(confirmed.url) + "." : "I couldn't confirm it on a primary page." })];
    return out;
  }
}

export { sameSite };
