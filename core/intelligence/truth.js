/* Truth and provenance.

   Every important conclusion ROYAL reaches is a Claim: a statement, its
   value, an evidence label, the sources behind it, when they were read, how
   fresh they are, and how confident ROYAL is.  Labels are never upgraded by
   presentation; a claim is VERIFIED_EXTERNAL only if ROYAL itself confirmed
   it from a source that deserves it.

   Knowledge priority, highest first (section 11 of the brief):
     1 authoritative live business source   VERIFIED / VERIFIED_INTERNAL
     2 current approved House knowledge      VERIFIED_INTERNAL (policy)
     3 freshly researched external source    VERIFIED_EXTERNAL / REPORTED_UNVERIFIED
     4 model background knowledge            MODEL_KNOWLEDGE
     5 inference                             INFERENCE
     6 unknown                               UNKNOWN */

import { EVIDENCE as E, CONFIDENCE as C } from "../enums.js";
import { stableHash } from "../util.js";

export const PRIORITY = [E.VERIFIED, E.VERIFIED_INTERNAL, E.VERIFIED_EXTERNAL, E.REPORTED_UNVERIFIED, E.MODEL_KNOWLEDGE, E.INFERENCE, E.RECOMMENDATION, E.UNKNOWN];
export const rank = (label) => { const i = PRIORITY.indexOf(label); return i < 0 ? 99 : i; };

/* Source quality, 0 (worst) to 5 (best), by domain and kind.  A heuristic,
   stated as one: it orders sources, it does not make a weak source true. */
const LOW_QUALITY = /(zoominfo|rocketreach|signalhire|contactout|lusha|leadiq|apollo\.io\/people|theorg\.com|crunchbase\.com\/person|craft\.co|owler|cbinsights|datanyze|6sense|wiza|clearbit|seamless\.ai|zoominfo\.com)/i;
const SOCIAL = /(reddit\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|tiktok\.com|quora\.com|medium\.com)/i;
const NEWS = /(reuters\.com|bloomberg\.com|wsj\.com|ft\.com|nytimes\.com|apnews\.com|cnbc\.com|forbes\.com|businesswire\.com|prnewswire\.com|globenewswire\.com|bizjournals\.com|fortune\.com|axios\.com|theinformation\.com)/i;
const GOV = /(\.gov(\.[a-z]{2})?$|sec\.gov|companieshouse|\.gov\.uk|europa\.eu)/i;
const PROFILE = /(linkedin\.com\/(in|company)\/)/i;

export function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch (_) { return ""; } }
export function sameSite(host, domain) { if (!host || !domain) return false; const d = domain.replace(/^www\./, "").toLowerCase(); return host === d || host.endsWith("." + d); }

export function sourceQuality(url, { officialDomain = null } = {}) {
  const host = hostOf(url), full = String(url || "");
  if (!host) return { score: 0, kind: "invalid" };
  if (officialDomain && sameSite(host, officialDomain)) return { score: 5, kind: "official" };
  if (GOV.test(host) || /sec\.gov/.test(full)) return { score: 5, kind: "government" };
  if (NEWS.test(host)) return { score: 4, kind: "reputable_news" };
  if (PROFILE.test(full)) return { score: 3, kind: "professional_profile" };
  if (LOW_QUALITY.test(full)) return { score: 1, kind: "data_aggregator" };
  if (SOCIAL.test(host)) return { score: 1, kind: "social" };
  return { score: 2, kind: "web" };
}

/* A claim.  `sources`: [{ url, title, retrieved_at, published_at, quality }]. */
export function claim({ subject, predicate, value, label, sources = [], retrieved_at = null, confidence = C.LOW, cross_checked = false, notes = null, freshness_class = "standard" }) {
  if (!E[label]) throw new Error("CLAIM_INVALID: unknown label " + label);
  if (label === E.VERIFIED_EXTERNAL && !sources.length) throw new Error("CLAIM_INVALID: VERIFIED_EXTERNAL needs a source");
  return {
    id: "clm_" + stableHash([subject, predicate, value, label]),
    subject: String(subject || "").slice(0, 200), predicate: String(predicate || "").slice(0, 120), value,
    label, sources: sources.slice(0, 12), retrieved_at, confidence, cross_checked: !!cross_checked, notes, freshness_class,
  };
}

/* Two or more sources disagree about one thing.  ROYAL does not choose. */
export function conflict(subject, predicate, alternatives) {
  return { kind: "SOURCE_CONFLICT", id: "cnf_" + stableHash([subject, predicate, alternatives.map((a) => a.value)]), subject, predicate, alternatives,
    summary: "Sources disagree about " + predicate + " for " + subject + ": " + alternatives.map((a) => JSON.stringify(a.value) + " (" + (a.sources || []).map((s) => hostOf(s.url)).filter(Boolean).join(", ") + ")").join(" vs ") + "." };
}

/* Confidence from the sources behind a claim. */
export function confidenceFrom(sources, { crossChecked = false, confirmedOfficial = false } = {}) {
  const best = Math.max(0, ...sources.map((s) => (s.quality && s.quality.score) || 0));
  const distinct = new Set(sources.map((s) => hostOf(s.url)).filter(Boolean)).size;
  if (confirmedOfficial || (best >= 4 && distinct >= 2)) return C.HIGH;
  if (best >= 4 || (best >= 3 && distinct >= 2) || crossChecked) return C.MEDIUM;
  if (best >= 1) return C.LOW;
  return C.NONE;
}

/* Research freshness classes: how long a finding may be reused. */
const H = 3600000, D = 24 * H;
export const FRESHNESS_TTL = Object.freeze({
  realtime: 5 * 60000,        /* prices, spot gold, scores */
  current_role: 7 * D,        /* who holds a role now */
  contact: 30 * D,            /* a professional email */
  news: 1 * D,
  standard: 7 * D,
  stable: 365 * D,            /* founding year, founders, history */
});

export function freshnessClass(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(price|spot|rate|stock|today'?s|right now|live|score|weather)\b/.test(t)) return "realtime";
  if (/\b(news|latest|this week|announc|recent)\b/.test(t)) return "news";
  if (/\b(ceo|cfo|coo|cto|cmo|president|chair|head of|vp|vice president|director|founder|owner|who runs|leads?)\b/.test(t) && !/\b(founded|founder of|who founded)\b/.test(t)) return "current_role";
  if (/\b(founded|history|born|invented|origin|established|who founded)\b/.test(t)) return "stable";
  return "standard";
}

/* Does a question need current information from outside? */
export function needsCurrentInfo(text) {
  const t = String(text || "").toLowerCase();
  return /\b(current|currently|now|today|latest|recent|this (week|month|year)|price|spot|who is the (ceo|cfo|coo|cto|president|head)|who runs|news|open(ing)? hours|regulation|market|trend)\b/.test(t)
    || freshnessClass(t) === "current_role" || freshnessClass(t) === "realtime";
}
