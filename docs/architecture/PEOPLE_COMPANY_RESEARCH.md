# PEOPLE AND COMPANY RESEARCH

*Updated 30 September 2026 from the code on branch feature/intelligence, after the security review.*

This is the path behind "Who is the CFO of Acme?" and "What's her email?". Company and executive research live in `core/intelligence/research/people.js` (class `ExecutiveResearch`). Contact research lives in `core/intelligence/research/contacts.js` (classes `ContactResearch`, `HunterProvider`, `ApolloProvider`). Both sit on the Research Engine (RESEARCH_ENGINE.md). Everything here needs `XAI_API_KEY` and `ROYAL_GROK_MODEL`; without them it is NOT CONFIGURED.

## 1. Company resolution

`resolveCompany(name)` runs one QUICK research call with `COMPANY_SCHEMA` (matches with name, official domain, description, headquarters, source URLs, and an `is_ambiguous` flag).

(a) A match's `source_urls` are kept only if the provider reported seeing them. A match with no surviving source is dropped.

(b) **The official domain is never taken on the model's word.** The domain the model names is normalised (scheme, `www.` and path removed, lowercased) and accepted as `official_domain` only if at least one of the match's surviving sources is on that domain or a subdomain of it (`sameSite`). Otherwise `official_domain` is null and the model's claim is kept as `claimed_domain`. This matters because the official domain decides which sources rank as official (score 5) and which email addresses count as business addresses (tested: "review: a company's domain is never taken on the model's word", where a model naming `attacker.example` with only an `acme.com` source leaves the domain null).

(c) No matches: status `NOT_FOUND`. `doPeople` says it couldn't identify the company and invents nothing.

(d) **More than one distinct company: always asked.** Matches are counted by official domain, else claimed domain, else lowercased name. More than one distinct company gives status `AMBIGUOUS`, whatever the model's `is_ambiguous` says, and `doPeople` asks "More than one company goes by X. Which one?" with a `company_choice` surface (tested: "review: an ambiguous company name is asked about, never picked").

(e) Otherwise `RESOLVED` with the match. `company_id` is `co_` plus a hash of the official domain (or name). The company carries `domain` (the accepted official domain, or null), `domain_unconfirmed` (the model's claimed domain when it was not accepted), description, headquarters and its sources with quality scores.

If the conversation already has an `active_company` with the same name, `doPeople` passes it in and resolution is skipped.

## 2. Executive and role research

`roleHolder(companyName, roleText)` runs one STANDARD research call with `ROLE_SCHEMA` and `freshness: "current_role"`, so the report is cached for seven days. The question names the role, the company, its domain and today's date, and asks for the official leadership or investor-relations page first. The model is told to copy titles exactly, including acting, interim, regional or subsidiary wording.

`roleKey` maps the request to one of: CFO, CEO, COO, CTO, CMO, President, Founder, Owner. An unrecognised role falls back to CFO.

**Title classification happens in code** (`classifyTitle`), never by the model:

| Result | Rule (for the role asked) | Example |
|---|---|---|
| `former` | former, ex-, previous, retired, "until 20xx", emeritus; or `is_current: false` | "Former Chief Financial Officer" |
| `acting` | acting or interim | "Interim CFO" |
| `deputy` | deputy, assistant, associate | "Deputy CFO" |
| `regional_or_subsidiary` | regional, EMEA, APAC, Americas, Europe, Asia, division, subsidiary, "group CFO of" | "CFO, EMEA" |
| `exact` | the role matches and none of the above | "Chief Financial Officer" |
| `related_title` | CFO only: VP, SVP, EVP, head or director of finance; controller; treasurer; finance director | "VP Finance", "Corporate Controller" |
| `unrelated` | anything else | |

Each candidate carries `match` and a plain `match_note` (for example "acting, not permanent").

**Outcome** (`roleHolder`):

(a) Candidates whose source URLs the provider did not report are dropped.

(b) Two or more different names classed `exact`: status `CONFLICT` with a `SOURCE_CONFLICT` summary. ROYAL does not pick.

(c) No `exact` candidate: `ONLY_RELATED_ROLES` if others were found (ROYAL names the closest and says why it is not the officer), else `NOT_FOUND`.

(d) **Name and role together.** With one `exact` name, ROYAL fetches up to three of that person's sources, best first. A source confirms only when `nameWithRole(pageText, name, roleRe)` is true:

(i) the role appears within 120 characters after the name, with no "former", "formerly", "ex-", "previous", "previously", "retired", "interim", "acting", "outgoing" or "until <year>" between them, and without another capitalised first and last name after a full stop, semicolon or line break in between (that would be someone else's title); or

(ii) the role appears earlier in the same sentence, within 80 characters before the name, with no disqualifying word, and no other capitalised full name between the role and the name ("Our CFO, Jane Smith").

"John Doe, CFO. Jane Smith, former CFO." does not confirm Jane Smith; "Jane Smith, Interim CFO" does not; "CFO John Doe and Jane Smith" does not (tested: "review: name and title must appear together, not as someone else's or a former title").

(e) Label: `VERIFIED_EXTERNAL` if the confirming source scores 4 or 5, else `REPORTED_UNVERIFIED`.

(f) Confidence: HIGH if confirmed on the official site; HIGH if confirmed on a strong source and backed by two or more distinct hosts; MEDIUM if confirmed on a strong source alone; unconfirmed with two or more hosts is MEDIUM; otherwise LOW.

The result `person` holds `person_id` (`pe_` plus a hash of name and company id), name, title, company, domain, since, identity and role confidence, label, `cross_checked`, `confirmed_on` and sources. It expires with the `current_role` TTL of seven days. `doPeople` stores it as `active_person` in the conversation and says how it knows: "confirmed on <host>", "found on <host>, not a primary source", or "reported by <hosts>, not confirmed by me". Flag `people_research: false` switches this intent off.

## 3. The contact pipeline

`ContactResearch.businessEmail(person)` tries each step in order and stops at the first address found.

| Step | Condition | Status if found |
|---|---|---|
| 1 Cache | `contacts` collection, key `ctc_` + person_id, not expired | as stored |
| 2 Public web | research is CONNECTED | `PUBLICLY_LISTED` on the company's own site; `UNVERIFIED` anywhere else |
| 3 Hunter Email Finder | `email_discovery` on and `HUNTER_API_KEY` set | `PROVIDER_FOUND` |
| 4 Apollo People Match | `email_discovery` on and `APOLLO_API_KEY` set | `PROVIDER_FOUND` |
| 5 Hunter domain pattern | `email_discovery` on and `HUNTER_API_KEY` set, and no opt-out | `PATTERN_INFERRED` |

(a) Without a known company domain (including a domain that was only claimed, section 1 (b)) the answer is `NOT_FOUND` at once.

(b) Step 2 runs a QUICK research asking whether an address is published on the company's domain. An address counts only if it is a business address at the company's domain and ROYAL fetches the cited page and finds the exact address written on it; otherwise a note says it was not used. If the page (after redirects) is on the company's own site the status is `PUBLICLY_LISTED`; if it is any other site the status is `UNVERIFIED`, found by "a third-party page (<host>), not the company's own site" (tested: "review: an address found off the company's site is UNVERIFIED, not PUBLICLY_LISTED"). This step does not depend on `email_discovery`, but it does need a fetcher.

(c) In steps 3 and 4, an address not on the company's domain is discarded with a note.

(d) **Opt-out.** A Hunter `451` (the person asked not to be listed) ends the provider loop and the whole lookup: no Apollo, no pattern, no verification. The result is `NOT_FOUND` with `opted_out: true`, and `doContact` says the person asked not to be listed and that ROYAL won't look up or guess an address (tested: "review: an opt-out (451) stops every other way of finding the address").

(e) Step 5 applies Hunter's pattern (for example `{first}.{last}`) with `applyPattern` to the name split by `splitName`.

(f) Nothing found: `NOT_FOUND`. `doContact` says "I won't guess one."

**Verification** runs when `email_verification` is on and Hunter is configured (`Hunter.verify`):

| Verifier status | State | Resulting email status |
|---|---|---|
| valid | `deliverable` | `VERIFIED_DELIVERABLE`, or `LIKELY_DELIVERABLE` if the address was pattern-inferred |
| invalid | `invalid` | `INVALID` |
| accept_all | `accept_all` | `RISKY` for a pattern guess; otherwise unchanged. Either way with a note that deliverability cannot be confirmed |
| unknown or other | `unknown` | `RISKY` when the verifier's score is below 50; otherwise unchanged. "The verifier could not decide." |
| webmail, disposable | `not_business` | `NOT_FOUND` |
| call failed | `unverified` | unchanged, with the failure reason |
| not run | `unverified` | unchanged, with a note that verification is off or not configured |

Every value of `EMAIL_STATUS` in `core/enums.js` is now assigned by some path. Results are cached for 30 days, or one day for `NOT_FOUND` (`_save`). A `CONTACT_RESEARCH` audit entry records the status only, never the address.

## 4. Exactly which provider endpoints are called

| Provider | Method and URL | Parameters | Auth |
|---|---|---|---|
| Hunter | `GET https://api.hunter.io/v2/email-finder` | `domain`, `first_name`, `last_name` | header `X-API-KEY` |
| Hunter | `GET https://api.hunter.io/v2/domain-search` | `domain`, `limit=1` | header `X-API-KEY` |
| Hunter | `GET https://api.hunter.io/v2/email-verifier` | `email` | header `X-API-KEY` |
| Apollo | `POST https://api.apollo.io/api/v1/people/match` | JSON: `first_name`, `last_name`, `domain`, `organization_name`, `reveal_personal_emails: false`, `reveal_phone_number: false` | header `X-Api-Key` |

The key is never put in the URL; a test checks this for Hunter. Status handling (`HunterProvider._get`, `ApolloProvider.findEmail`): 429 is rate limited, 401 or 403 is an auth failure, 451 (Hunter) is an opt-out, 202 or 222 (Hunter) is verification pending. Timeout is 20 seconds. In-process quotas (`Quota`): Hunter 60 a minute and `HUNTER_DAILY_LIMIT` a day (default 200); Apollo 30 a minute and `APOLLO_DAILY_LIMIT` a day (default 100). Quotas reset when the server restarts.

## 5. Privacy rules

(a) Business addresses only: `isBusinessEmail` requires the company's domain or a subdomain of it.

(b) Webmail is discarded. `WEBMAIL` matches the whole domain after `@`: gmail.com, googlemail.com, yahoo, hotmail, outlook, live, gmx and yandex under any one- or two-part country ending (for example yahoo.co.uk), ymail.com, msn.com, aol.com, icloud.com, me.com, mac.com, proton.me, protonmail.com, protonmail.ch, pm.me, mail.com and zoho.com. A business's own mail host, such as `mail.acme.com`, is not webmail (tested).

(c) Apollo is told not to reveal personal emails or phone numbers.

(d) The public-web prompt forbids personal addresses, phone numbers and home addresses. No code asks for any of them.

(e) Hunter opt-outs are respected, stop every other way of finding the address, and are reported.

## 6. Prospects and the ACE handoff

`doProspecting` (`core/intelligence/index.js`) runs a DEEP research with `PROSPECT_SCHEMA` and two angles, and applies the same checks as company and executive research:

(a) Items without a provider-reported source are dropped.

(b) A prospect's domain is kept only if one of its reported sources is on it; otherwise it is null, and source quality is scored against the accepted domain only.

(c) The buyer is confirmed only by `nameWithRole` on the best source (one fetch), using the first words of the buyer's title as the role. Confirmed on a source scoring 4 or 5 gives `VERIFIED_EXTERNAL`; otherwise `REPORTED_UNVERIFIED`, with `cross_checked` recording whether the name and title were found together; `UNKNOWN` with no buyer.

Each prospect item is `{ company, domain, why, person, title, label, cross_checked, sources }`. Nothing is written to a CRM (`create_crm_lead` is approval-required and no CRM is connected). The list is stored in conversation context as `prospects`, but no code reads that key yet. Prospecting with research connected has no test.

`doOutreach` builds the handoff from `active_person` and `active_company`: person (id, name, title, email, email_status), company, objective, requested output, up to four research claims with their labels, up to four source URLs, House offer passages from the Knowledge Engine, and constraints (no pricing, no promised dates, no invented facts, under 140 words). The writer is chosen by `routeAgents` (normally ACE) and drafts through `gate.request` with tool `draft_email`. The draft's address is used only if it is a business address and its status is not `INVALID` or `NOT_FOUND`. Sending is a separate, approval-gated step; see `APPROVAL_MODEL.md`, section 6.
