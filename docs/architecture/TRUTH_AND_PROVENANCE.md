# TRUTH AND PROVENANCE

*Updated 30 September 2026 from the code on branch feature/intelligence, after the security review.*

Every important conclusion ROYAL shows carries a label that says how ROYAL knows it. The label travels with the value from the code that produced it to the pixel that shows it, and presentation never upgrades it. The vocabulary is in `core/enums.js`; the claim, quality and confidence rules are in `core/intelligence/truth.js`.

## 1. Evidence labels

`EVIDENCE` in `core/enums.js`, in priority order (`PRIORITY` and `rank` in `truth.js`):

| Label | Meaning | Where it is set |
|---|---|---|
| `VERIFIED` | Read from an authoritative internal system. The original House label. | House skills; the `calc` surface; `sources` on every command result (`core/royal.js`) |
| `VERIFIED_INTERNAL` | The same, spelled out; also approved House knowledge | `doKnowledge` when it answers from a passage without a model |
| `VERIFIED_EXTERNAL` | An external fact ROYAL confirmed itself on a source scoring 4 or 5 | `ResearchEngine.research`, `roleHolder`, `doProspecting` |
| `REPORTED_UNVERIFIED` | A source says it; ROYAL did not confirm it on a strong source | same three places, as the default |
| `MODEL_KNOWLEDGE` | The language model's background knowledge; never current by default | `doWorld` |
| `INFERENCE` | ROYAL's reasoning from other facts | `doKnowledge` when a model wrote the answer |
| `RECOMMENDATION` | Advice or a draft | `message_draft` and `email_draft` surfaces (`core/composer.js`) |
| `UNKNOWN` | Not known | prospect items with no buyer; people surfaces with no name |

`fact(value, { label })` in `core/sources.js` and `claim(...)` in `truth.js` both throw on a label that is not in `EVIDENCE`.

## 2. Claim objects

`claim({ subject, predicate, value, label, sources, retrieved_at, confidence, cross_checked, notes, freshness_class })` returns:

`{ id, subject, predicate, value, label, sources, retrieved_at, confidence, cross_checked, notes, freshness_class }`

(a) `id` is `clm_` plus a hash of subject, predicate, value and label.

(b) Subject is cut to 200 characters, predicate to 120, sources to 12.

(c) A `VERIFIED_EXTERNAL` claim with no sources throws `CLAIM_INVALID`.

(d) Each source is `{ url, title, retrieved_at, published_at, quality: { score, kind }, confirmed? }`. `confirmed: true` marks the page ROYAL itself found the value on.

## 3. Source quality

`sourceQuality(url, { officialDomain })` in `truth.js` scores a source from 0 to 5 by domain. It is a heuristic for ordering sources; it does not make a weak source true. The first rule that matches wins:

| Score | Kind | Rule |
|---|---|---|
| 5 | official | host is the company's official domain or a subdomain (`sameSite`) |
| 5 | government | `.gov`, `.gov.xx`, sec.gov, Companies House, europa.eu |
| 4 | reputable_news | Reuters, Bloomberg, WSJ, FT, NYT, AP, CNBC, Forbes, Business Wire, PR Newswire, GlobeNewswire, Biz Journals, Fortune, Axios, The Information |
| 3 | professional_profile | `linkedin.com/in/` or `linkedin.com/company/` |
| 1 | data_aggregator | ZoomInfo, RocketReach, SignalHire, ContactOut, Lusha, LeadIQ, Apollo people pages, TheOrg, Crunchbase person pages, Craft, Owler, CB Insights, Datanyze, 6sense, Wiza, Clearbit, Seamless.AI |
| 1 | social | Reddit, X, Twitter, Facebook, Instagram, TikTok, Quora, Medium |
| 2 | web | anything else |
| 0 | invalid | no parsable host |

Only sources scoring 3 or more are fetched for cross-checking, and only a confirmation on a source scoring 4 or 5 earns `VERIFIED_EXTERNAL`.

The official domain that earns a source the score of 5 is itself checked: `resolveCompany` and `doProspecting` accept a domain only when one of the sources the search provider reported is on it, and otherwise leave it null (`PEOPLE_COMPANY_RESEARCH.md`, section 1 (b)). A model cannot promote a site to "official" by naming it.

## 4. Confidence rules

`CONFIDENCE` is `HIGH`, `MEDIUM`, `LOW` or `NONE`. For research claims, `confidenceFrom(sources, { crossChecked, confirmedOfficial })` gives:

(a) HIGH: confirmed on the official site, or the best source scores 4 or more and there are two or more distinct hosts.

(b) MEDIUM: the best source scores 4 or more, or scores 3 with two or more hosts, or the claim was cross-checked.

(c) LOW: any source scoring 1 or more.

(d) NONE: otherwise.

A research report is only as strong as its weakest claim: it takes the lowest claim confidence, drops to LOW whenever the report holds a conflict, and is NONE with no claims (`ResearchEngine.research`). Executive research has its own rule in `roleHolder` (PEOPLE_COMPANY_RESEARCH.md, section 2), and a person is confirmed only when the name and the role appear together on the page (`nameWithRole`, same document).

## 5. Conflicts

ROYAL reports disagreement; it does not choose.

(a) Research: `conflict(subject, predicate, alternatives)` in `truth.js` returns `{ kind: "SOURCE_CONFLICT", id: "cnf_...", subject, predicate, alternatives: [{ value, sources, label }], summary }`. The summary names each value with the hosts behind it.

(b) Executive research: `roleHolder` returns `status: "CONFLICT"` and `conflict: { kind: "SOURCE_CONFLICT", summary }` when sources name different people for one role.

(c) House data: `sourceConflict(domain, entity, a, b)` in `core/sources.js` returns `{ kind, domain, entity, id: "conf_...", values, summary }`. It is exercised only by `tests/core.test.js`; no second House source is connected to disagree with the calculator.

## 6. How labels reach the UI

(a) Handlers in `core/intelligence/index.js` put the label on the surface (`surface.label`, or per claim, per person, per prospect item).

(b) `core/composer.js` (`compose`, through the surface cases in `fromSurface`) copies labels into validated primitives: `STATEMENT.evidence.label`, `KNOWLEDGE_OBJECT.label`, `RESEARCH_OBJECT.claims[].label` (through `claimPrim`), `PERSON_OBJECT.label` and `email_status`, `PROSPECT_LIST.items[].label`, `MESSAGE_VIEW.label` and `address_status`. Sources pass through `sourcePrim`, which keeps `kind` and `confirmed`.

(c) Defaults in the composer only ever fall to the weaker label: a person with a name and no label shows `REPORTED_UNVERIFIED`, with no name `UNKNOWN`. The one exception is `KNOWLEDGE_OBJECT`, which defaults to `VERIFIED_INTERNAL` when no label is set; `doKnowledge` always sets one.

(d) `web/js/schema.js` validates every primitive; `label` is a required string on the objects above.

(e) `web/js/primitives.js` renders labels in words through `LABEL` (for example `REPORTED_UNVERIFIED` is "Reported, not verified", `MODEL_KNOWLEDGE` is "General knowledge, not checked") and email statuses through `EMAIL`.

## 7. Pattern-inferred never reads as verified

(a) `ContactResearch.businessEmail`: a pattern guess that the verifier calls valid becomes `LIKELY_DELIVERABLE`, never `VERIFIED_DELIVERABLE`. A test asserts this.

(b) `doContact` says "a guess from the company's email pattern, not verified", or for `LIKELY_DELIVERABLE` "it came from a pattern".

(c) `web/js/primitives.js` shows `PATTERN_INFERRED` as "Guessed from the company's pattern, not verified" and `LIKELY_DELIVERABLE` as "Likely deliverable (pattern)".

(d) `doSend` treats only `VERIFIED_DELIVERABLE` and `PUBLICLY_LISTED` as verified. Any other status raises the send decision's risk from YELLOW to ORANGE and adds the unknown "The address is not verified deliverable."

(e) `PROVIDER_FOUND` is likewise never shown as verified: "found by hunter, not independently verified".

(f) An address ROYAL found written on a page that is not the company's own site is `UNVERIFIED` ("found a third-party page (<host>), not the company's own site, not verified"); only the company's own site gives `PUBLICLY_LISTED`.

(g) `RISKY` is assigned when the verifier reports `accept_all` for a pattern guess, or cannot decide and scores the address below 50. `doContact` says "risky: it may not reach anyone".

(h) A send Decision to any address other than `VERIFIED_DELIVERABLE` or `PUBLICLY_LISTED` is raised at ORANGE (item d), which covers `UNVERIFIED`, `RISKY`, `LIKELY_DELIVERABLE`, `PROVIDER_FOUND` and `PATTERN_INFERRED`.

## 7a. Sent means what the provider confirmed

For an approved email, `VERIFIED` on the Decision means Resend reported the message delivered; a reported bounce, failure or complaint makes it FAILED; anything else leaves it EXECUTED, accepted but not confirmed (`emailExecutor` in `core/intelligence/comms.js`; `APPROVAL_MODEL.md`, section 6 (g)).

## 8. Freshness

Research freshness classes and TTLs are in RESEARCH_ENGINE.md, section 3. House-domain freshness (`CURRENT`, `RECENT`, `STALE`, `UNKNOWN`) is `freshness(domain, verifiedAt)` in `core/sources.js`; see SOURCE_REGISTRY.md.
