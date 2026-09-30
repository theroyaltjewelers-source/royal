# SOURCE REGISTRY

*Written 30 September 2026 from the code on branch feature/intelligence.*

The source registry says where each kind of fact comes from, how fresh it must be, and what happens when two sources disagree. It is `SOURCE_REGISTRY` in `core/sources.js`, a deep-frozen object. This document covers the House domains registered there and the external kinds of fact the intelligence layer handles, which are not registered there.

## 1. How the registry is used

(a) `freshness(domain, verifiedAt)` returns `CURRENT` when the age is within the domain's `current` window, `RECENT` within `recent`, otherwise `STALE`. It returns `UNKNOWN` for an unregistered domain or a missing time.

(b) `ageText(verifiedAt)` words the age ("verified 5 minutes ago").

(c) `sourceConflict(domain, entity, a, b)` builds the `SOURCE_CONFLICT` object.

(d) `SourceHealth` holds each source's connection state. A source never set is `NOT_CONNECTED`. `core/royal.js` creates one and reads the calculator's entry.

(e) Skills in `skills/index.js` name their domains in metadata (`sources: ["RECEIVABLE", "PAYMENT"]`).

On this branch `freshness` and `sourceConflict` are called only from `tests/core.test.js`. No runtime code reads `SOURCE_REGISTRY` directly. The `adapter` values are descriptive names, not keys the code looks up. The working path for calculator data is the `calculator` adapter in `core/intelligence/gateway.js#defaultGateway`.

## 2. House domains

Every row is registered in `core/sources.js`. "Current" and "recent" are the freshness windows.

| Domain | Authoritative | Fallback | Current / recent | Adapter | Status |
|---|---|---|---|---|---|
| PROJECT_STATUS | calculator | none | 15 min / 6 h | royal_t.calculator | Connected when the calculator has pushed a snapshot |
| CLIENT | calculator | jewel360 | 1 h / 24 h | royal_t.calculator | Fallback NOT CONNECTED |
| PRODUCTION | calculator | vendor_report | 15 min / 6 h | royal_t.calculator | Vendor reports are not ingested |
| PAYMENT | calculator | quickbooks | 15 min / 6 h | royal_t.calculator | Fallback NOT CONNECTED |
| RECEIVABLE | calculator | none | 15 min / 6 h | royal_t.calculator | Computed from calculator data |
| TREASURY | calculator | none | 1 h / 24 h | royal_t.calculator | Calculator Treasury |
| APPOINTMENT | none | none | 15 min / 6 h | none | NOT CONNECTED |
| SALES_PIPELINE | calculator | jewel360 | 1 h / 24 h | royal_t.calculator | Fallback NOT CONNECTED; no CRM |
| POLICY | royal.docs | none | always / always | royal.knowledge | Knowledge Engine, loaded at start |
| COMMITMENT | royal.store | calculator | 15 min / 6 h | royal.commitments | ROYAL's store plus calculator target dates |
| VENDOR | calculator | none | 1 h / 24 h | royal_t.calculator | Treasury vendor directory |
| SOFTWARE_STATUS | royal.health | none | 5 min / 1 h | royal.forge | Connector heartbeats and ingest results |

**Verification rule and conflict handling, per domain** (from each entry's `verification` text):

(a) PROJECT_STATUS: read from the calculator's own project records through its House API. There is no second source, so there is nothing to conflict with.

(b) CLIENT: the calculator client record by ID. A Jewel360 mismatch would raise `SOURCE_CONFLICT`, but Jewel360 is NOT CONNECTED (`defaultGateway` registers it with status `NOT_CONNECTED`, "No adapter yet").

(c) PRODUCTION: stage and manufacturer payments from the calculator. Vendor statements are `REPORTED_UNVERIFIED`.

(d) PAYMENT: live, non-voided payments recorded in the calculator. They are recorded, not bank-verified. QuickBooks is NOT CONNECTED.

(e) RECEIVABLE: project value less live payments, computed by the calculator's own functions.

(f) TREASURY: bills, debts, capital and runway from the calculator's Treasury.

(g) APPOINTMENT: no calendar is connected. The gateway's `calendar` adapter is NOT CONNECTED. Freshness windows exist, but there is no source to measure.

(h) SALES_PIPELINE: projects at the Inquiry stage stand in for the pipeline until a CRM is connected. The `crm` adapter is NOT CONNECTED.

(i) POLICY: the versioned Policy Manual. Only ACTIVE policies bind. Freshness is always current because the documents are the authority. See KNOWLEDGE_ENGINE.md.

(j) COMMITMENT: recorded commitments, plus calculator target dates treated as commitments to the client.

(k) VENDOR: the Treasury vendor directory.

(l) SOFTWARE_STATUS: connector heartbeats and ingest results.

## 3. External domains

Kinds such as `PUBLIC_COMPANY`, `PUBLIC_PERSON` and `PROFESSIONAL_CONTACT` are **not registered** in `core/sources.js`. None of those names appears anywhere in the code. Their behaviour is written into the research modules instead. The table below states that behaviour; the domain names are this document's, not the code's.

| Kind (unregistered) | Authoritative | Fallback | Freshness | Adapter | Verification rule | Conflict handling |
|---|---|---|---|---|---|---|
| Public company facts | The company's official site (quality 5) or government filings (5) | Reputable news (4), then other web | `FRESHNESS_TTL` by question class: 5 min to 365 days | `research` in `defaultGateway` (xAI search plus `SafeFetcher`) | `VERIFIED_EXTERNAL` only if ROYAL finds the value on a page scoring 4 or 5 | `conflict()` in `truth.js`; confidence LOW |
| Company identity | Official domain found by search | none | stored with the report | `ExecutiveResearch.resolveCompany` | Match kept only with a provider-reported source or a domain | `AMBIGUOUS`: ROYAL asks which company |
| Public person in a role | Official leadership or IR page | Filings, reputable news, LinkedIn (3) | `current_role`: 7 days | `ExecutiveResearch.roleHolder` | Name and role both found on the fetched page, which scores 4 or 5 | Two different exact holders give `CONFLICT`; ROYAL does not pick |
| Professional contact | The address written on the company's own page | Hunter, then Apollo, then Hunter's pattern | 30 days found, 1 day not found | `contacts` in `defaultGateway` (`ContactResearch`) | Hunter Email Verifier when `email_verification` is on | Not modelled: first source found wins; later steps are skipped |
| World background | Language model | none | not cached | `GrokProvider.complete` via `doWorld` | none; always `MODEL_KNOWLEDGE` | none |

All five need `XAI_API_KEY` and `ROYAL_GROK_MODEL`. Professional contact beyond the public page also needs `HUNTER_API_KEY` or `APOLLO_API_KEY`, with flag `email_discovery` on. Without them each is NOT CONFIGURED.

## 4. Adapters with no source

`defaultGateway` registers six adapters that exist only so the planner and permission engine know about them. Each reports `NOT_CONNECTED` with "No adapter yet": `crm`, `calendar`, `gold_buy`, `quickbooks`, `jewel360`, `instagram`. Any registry domain whose fallback or authority points at one of these is NOT CONNECTED for that path.
