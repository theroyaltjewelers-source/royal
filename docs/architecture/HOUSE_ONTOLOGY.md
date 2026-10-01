# HOUSE ONTOLOGY

*The canonical concepts ROYAL uses, where each comes from today, and its canonical id. Terms and definitions: `ROYAL_HOUSE_LANGUAGE.md`.*

| Concept | Canonical id | Source of truth today | Status |
|---|---|---|---|
| PROJECT (commission) | calculator project id, `PRJ-YYYY-NNNNN` | Project Calculator snapshot | live |
| CLIENT | calculator client id, `CL-NNN` (name is an alias) | calculator snapshot (name, has_email only; no contact details by design) | live |
| PRODUCTION_STAGE | calculator stage name (`STAGES`) | calculator | live |
| PAYMENT, RECEIVABLE | per project: value, paid, outstanding | calculator | live |
| OBLIGATION (payable) | treasury inbox key | calculator treasury | live, totals only |
| COMMITMENT | `cmt_` hash; project target dates | ROYAL store and calculator | live |
| WAITING_DEPENDENCY | `wt_` hash | ROYAL store and GRACE | live |
| DECISION, APPROVAL | `dec_` hash | ROYAL store | live |
| TASK | `tsk_` hash | ROYAL store | live |
| AGENT | `ace`, `grace`, `ledger`, `house`, `forge` | registry | live |
| AGENT_TASK | `tsk_` id, bridge `request_id` | ROYAL store, bridge | live |
| AUDIT_EVENT | log id, `audit_NNNNNNNN` | ROYAL audit log | live |
| BUSINESS_EVENT | log id with dedupe key | ROYAL events log | live |
| POLICY | `POL-XXX-NNN` | Policy Manual | live |
| PERSON, COMPANY | `pe_`, `co_` hash of name and domain | research memory | live, research only |
| MESSAGE | bot event id; outreach draft id | bridge, conversation | partial |
| LEAD, PROSPECT | calculator projects at Inquiry; research prospects | calculator, research | partial: no CRM connected |
| APPOINTMENT | none | no calendar connected | NOT CONNECTED |
| VENDOR | name in treasury inbox text | calculator | partial: no vendor id |
| DESIGN, CAD, ORDER | calculator stage only | calculator | partial |
| CONTENT_ASSET, CAMPAIGN | none | no marketing system | NOT CONNECTED |
| RISK, EXCEPTION | finding code and key | specialists | live |

**Rule:** one real entity, one canonical id. Names are aliases resolved to ids (`resolveEntity()`); two records with one name are flagged, never merged silently (`ROYAL_SYSTEM_CONGRUENCE.md`). A second system joins by mapping `source_system` and `source_record_id` onto these ids.
