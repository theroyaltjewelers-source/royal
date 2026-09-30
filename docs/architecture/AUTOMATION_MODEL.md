# AUTOMATION MODEL

## 1. Maturity Ladder

`OBSERVE, ANALYZE, RECOMMEND, DRAFT, INTERNAL_ACTION, APPROVED_EXTERNAL_ACTION, LIMITED_STANDING_AUTONOMY` (`core/enums.js#MATURITY`).

A capability climbs one rung at a time, each rung behind a flag and an ADR, never skipping to the top.

## 2. Where V1 Stands

| Capability | Rung | Gate |
|---|---|---|
| Triage, briefing, step-away, status, waiting, commitments, changes | ANALYZE / RECOMMEND | Read-only |
| Client message drafts | DRAFT | Nothing is sent |
| Internal tasks | INTERNAL_ACTION behind approval | `agent_internal_write` off |
| Sending client messages | APPROVED_EXTERNAL_ACTION designed, no executor | `agent_external_send` off, no messenger |
| Money movement | none | PROHIBITED autonomously. Approval-class, no executor. |
| Deployments | none | Approval-class, no executor |

## 3. "Handle It"

Handle It turns the last answer's actionable items into delegations, drafts, internal tasks and approval requests, and states how completion will be verified: the item clears when the calculator's records change, and ROYAL rechecks at the next reading. Authority can expand by flipping flags and adding executors. The skill does not change.

## 4. Standing Autonomy (Future)

A standing authorization would be a recorded ADR naming the tool, the limit (for example, routine balance reminders under a set amount, at most once a week per client), the verification, and the revocation path. The permission engine would read it as data. It does not exist yet.

## 5. Scheduling

Skills are callable by name, so scheduling is a caller concern: a scheduler posts `{"skill": "morning_briefing", "modality": "automation"}` to `/v1/command` with an owner token. No scheduler is set up in V1.
