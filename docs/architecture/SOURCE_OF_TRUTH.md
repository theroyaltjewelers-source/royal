# SOURCE OF TRUTH

Source: `core/sources.js#SOURCE_REGISTRY`.

## 1. Registry

| Domain | Authoritative | Fallback | Adapter | Current if under | Recent if under | Verification |
|---|---|---|---|---|---|---|
| PROJECT_STATUS | calculator | none | royal_t.calculator | 15 min | 6 h | Calculator project records via the House API |
| CLIENT | calculator | Jewel360 (not connected) | royal_t.calculator | 1 h | 24 h | Client record by ID. A Jewel360 mismatch would raise SOURCE_CONFLICT. |
| PRODUCTION | calculator | vendor report (unverified) | royal_t.calculator | 15 min | 6 h | Stage and manufacturer payments |
| PAYMENT | calculator | QuickBooks (not connected) | royal_t.calculator | 15 min | 6 h | Live payments **recorded** in the calculator. Not bank-verified. |
| RECEIVABLE | calculator | none | royal_t.calculator | 15 min | 6 h | Value less live payments, computed by the calculator |
| TREASURY | calculator | none | royal_t.calculator | 1 h | 24 h | Treasury: bills, debts, capital, runway |
| APPOINTMENT | none | none | none | | | No calendar is connected |
| SALES_PIPELINE | calculator | Jewel360 (not connected) | royal_t.calculator | 1 h | 24 h | Projects at Inquiry and Design |
| POLICY | royal.docs | none | royal.knowledge | always | always | Versioned manual. Only ACTIVE policies bind. |
| COMMITMENT | royal.store | calculator target dates | royal.commitments | 15 min | 6 h | Recorded commitments plus target dates |
| VENDOR | calculator | none | royal_t.calculator | 1 h | 24 h | Treasury vendor directory |
| SOFTWARE_STATUS | royal.health | none | royal.forge | 5 min | 1 h | Connector heartbeats and ingest results |

Older than "recent" is STALE. With no reading at all, UNKNOWN.

## 2. Rules

(a) ROYAL states a fact only with its label, source and age ("Verified · calculator · verified 4 minutes ago").

(b) When two sources disagree, ROYAL does not choose. It produces a `SOURCE_CONFLICT` (`core/sources.js#sourceConflict`) carrying both values and sources, and surfaces it as a Decision of type SOURCE_CONFLICT. V1 has one live source per domain, so no conflict can arise yet. The mechanism is built and tested for when Jewel360 or QuickBooks connect.

(c) A cached value is only ever shown with its age. Stale data blocks a clean answer to "Can I step away?".

(d) If a source cannot be reached, ROYAL names the source and says which conclusion was therefore not drawn. It never fills the gap.

## 3. How Calculator Truth Reaches ROYAL

(a) The calculator computes `houseSnapshot()` (contract `rtj.house.v1`) with its own functions after both projects and treasury have loaded, then pushes it to `POST /v1/ingest/calculator` with the signed-in user's token. It pushes again (debounced 2.5 s) after every successful guarded save, every 5 minutes while visible, and when the tab becomes visible.

(b) ROYAL validates the contract, rejects forbidden fields, keeps the latest and previous snapshots, the first snapshot of each day, and a "last seen" checkpoint, and derives freshness from `generated_at`.

(c) A rejected snapshot leaves the last good one in place and raises `INTEGRATION_FAILED`.
