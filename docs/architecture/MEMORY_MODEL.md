# MEMORY MODEL

Four layers, never mixed.

| Layer | What | Where | Lifetime | Is it evidence? |
|---|---|---|---|---|
| 1. Conversation context | The entity a conversation is about, the last skill, the last items (for "his project", "handle it") | `core/context.js#ConversationContext`, in process | 6 hours, then forgotten | Never. It only resolves references. |
| 2. Operational memory | Latest, previous, daily and checkpoint calculator snapshots; decisions; tasks; recorded commitments and waiting items; events | ROYAL store | Durable | Snapshots yes (with age). ROYAL's own records are labelled with their evidence. |
| 3. Institutional memory | Company Bible, Policy Manual, constitutions, case library, skill library, ADRs | `docs/` (versioned in git) | Durable, changed only by Tahir | Policy, not operational fact |
| 4. User context | Tahir's durable preferences needed to operate (owner id, time zone, owner map for tasks) | Server configuration (`ROYAL_OWNER_IDS`, `ROYAL_TZ_OFFSET_MIN`), `DEFAULT_OWNERS` | Durable | Not business state |

## Rules

(a) No layer answers a question that belongs to another. Conversation memory never says what a client paid. Snapshots never say what Tahir prefers.

(b) Model context is minimal. The open-question path sends at most the State of the House lines and the top twelve triage items as labelled facts, inside a `<data>` block. It never sends the whole snapshot, the docs or the conversation.

(c) Corrections are captured, not auto-promoted. When Tahir corrects ROYAL, the correction is classified (case-specific, agent behaviour, policy, skill, data), and only Tahir turns it into policy (`HOUSE_POLICY_MANUAL.md` section 11). A correction store is next-phase work; today a correction is recorded as a case in `ROYAL_REAL_CASES.md`.

(d) The personal realm will have its own operational memory, keyed by domain. The realm wall in permissions applies to memory reads as well as tools.
