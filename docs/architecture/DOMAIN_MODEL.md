# DOMAIN MODEL

Principle: no duplicate canonical models. Where the calculator already owns a concept, ROYAL references it by ID through the House API and never keeps a competing copy.

## 1. Ownership Map

| Concept | Owner | In ROYAL |
|---|---|---|
| Client | Calculator (`clients/<id>`) | Reference: `{id, name, has_email}`. No email, address or phone leaves the calculator. |
| Lead | Calculator (project at Inquiry/Design) | Derived view (ACE pipeline) |
| Project / Order | Calculator (`projects/<id>`, `PRJ-YYYY-NNNNN`) | Snapshot projection (see contract) |
| Payment, Receivable | Calculator (`payments[]`, `livePays`) | Figures only: paid, outstanding, capital |
| Obligation (vendor) | Calculator Treasury | Treasury inbox items |
| Appointment | Not connected | none |
| Task | ROYAL (`tasks`) | `{id, title, owner, project_id, verification, status, created_at, source_item}` |
| Commitment | ROYAL (`commitments`) + derived from calculator target dates | see section 2 |
| Decision / Approval | ROYAL (`decisions`) | see `PERMISSION_MODEL.md` |
| Risk | ROYAL, derived | Finding with `kind: RISK`, never stored as a fact |
| WaitingDependency | ROYAL (`waiting`) + derived from stage | see section 3 |
| ProductionEvent / BusinessEvent | ROYAL (`events`, append-only) | see `EVENT_MODEL.md` |
| Message | Not connected | Drafts live inside Decisions |
| Vendor | Calculator Treasury directory | Name within Treasury items |
| Agent, AgentRun, AgentAction | ROYAL registry, run ids, gate requests | |
| Skill | ROYAL (`skills/index.js`) | |
| Policy, PolicyVersion | ROYAL docs (`HOUSE_POLICY_MANUAL.md`, ids `POL-*`) | |
| AuditEvent | ROYAL (`audit`, append-only) | |
| SourceReference | `evidence {label, source, verified_at, freshness}` on every finding | |

## 2. Commitment

Fields: `id, type, made_by, made_to, client_id, project_id, description, source_reference, created_at, due_at, owner, status, verification_required, verification_evidence, next_action, next_check_at, escalation_threshold, completed_at, evidence`.

Statuses: OPEN, DUE_SOON (7 days), OVERDUE, REPORTED_COMPLETE, VERIFIED_COMPLETE, CANCELLED.

(a) Derived: each project target date is a `DELIVERY_DATE` commitment from "The House" to the client, `evidence: VERIFIED (calculator)`. It becomes REPORTED_COMPLETE at Ready or Delivered.

(b) Recorded: `record_commitment` (INTERNAL_WRITE) stores one with `evidence: REPORTED_UNVERIFIED`. "What did I personally promise?" filters `made_by` for Tahir and says so plainly when none are recorded.

## 3. WaitingDependency

Fields: `id, waiting_for_type, waiting_for_entity, reason, project_id, owner, waiting_since, days, expected_by, escalation_threshold_days, overdue, since_basis, resolved_at, evidence`. Types: CLIENT, PAYMENT, CAD, APPROVAL, MATERIALS, STONES, SETTER, MANUFACTURER, SHIPPING, STAFF, AGENT, TAHIR, EXTERNAL_PARTY.

## 4. Risk vs Status vs Priority

Three separate fields on every item: operational **status** (the calculator's stage), **risk** (GREEN to BLACK), **priority** (P0 to P4). Example: stage Production, risk RED, priority P1. An AI risk rating carries its own evidence label and never overwrites the stage.

## 5. Identity

Every entity is referenced by a stable ID: `PRJ-...` for projects, the calculator's client id, `dec_`/`tsk_`/`cmt_`/`wt_` hashes for ROYAL objects. Names are display only. Two clients named Johnson are two IDs, and ROYAL asks which one.

## 6. House API Contract (rtj.house.v1)

```
{ contract, generated_at, app_build,
  meta: { save_conflicts },
  load: { capped, notes[] },
  projects: [{ id, name, stage, archived, deleted,
               client: { id, name, has_email },
               due, created_at, updated_at, stage_since, last_activity_at,
               value, paid, capital, spent, mfr_quote, mfr_paid, outstanding, gross_margin,
               health: { s: ok|wait|risk, t }, next_action: { do, why },
               attention: [{ code, sev, sec, why }], enh_requests, closeout }],
  clients: [{ id, name, has_email }],
  treasury: { available, collected, receivable, payable, protected_capital, runway_days, runway_level,
              inbox: [{ key, sev, title, desc, amount, sec }] } }
```

Validation (`realms/business/royal-t/contract.js`) rejects an unknown contract or stage, a non-numeric money field, and any field whose name suggests a credential, an address or an account number.
