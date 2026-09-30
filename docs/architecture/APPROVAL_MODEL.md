# APPROVAL MODEL

*Updated 30 September 2026 from the code on branch feature/intelligence, after the security review.*

ROYAL may propose anything. It may only do what `core/permissions.js` allows, and anything consequential happens only as the executor of a Decision that Tahir resolved himself. This document follows one action from the words that start it to the report that ends it, and then walks the external email flow in full.

## 1. The Flow

| Stage | Where | What happens |
|---|---|---|
| INTENT | `core/royal.js#handle`, `core/intent.js#interpret`, `core/intelligence/intent_engine.js` | House rules run first. `classifyByRules` handles what must never be guessed: arithmetic, "send", "stop", revisions, sources. A model classification (`classify`) is used only for open questions, only when valid against `INTENT_SCHEMA`, and a model "send" with no draft open becomes `unknown`. The choice is audited as `INTENT_CLASSIFIED`. |
| PLAN | `core/intelligence/planner.js#planFor` | Templates for prospecting, executive contact and outreach. `annotate()` marks each step `requires: approval / internal_write / prohibited / none` and `available`. Used only by prospecting, where the plan is shown as a PLAN_OBJECT. Executing a plan step by step is NOT IMPLEMENTED; a plan grants no authority. |
| PROPOSED | `core/intelligence/index.js` (`doOutreach`, `doRevise`); `core/royal.js#openQuestion` | A draft is held in the conversation as `active_draft` (in memory, `ConversationContext`, six hour lifetime). The model's own proposed actions from an open question are capped at three and each goes to the gate. |
| PERMISSION CHECK | `PermissionService.check` | Unknown tool, prohibited, unknown or inactive agent, not in charter, outside realm: refused. APPROVAL_REQUIRED, or INTERNAL_WRITE with `agent_internal_write` off: `requiresApproval`. See `PERMISSION_MODEL.md`. |
| DECISION | `ConsequenceGate.request` then `DecisionService.create` (`core/decisions.js`) | An approval-class request becomes a Decision carrying `action: { tool, args, domain }`. Nothing runs. If the same action was already decided, the gate returns that Decision with `already_decided: true` (section 3). |
| APPROVE / MODIFY / REJECT | `DecisionService.resolve`, via `POST /v1/decisions/:id/resolve` and `royal.resolveDecision` | Only an actor with `role: "owner"` (from the server's owner allow-list). REJECT executes nothing. MODIFY shallow-merges `modified_args` into the action's arguments. |
| EXECUTE | `DecisionService._execute` | Runs the executor registered for the tool. With no executor the result is `NO_EXECUTOR` and the approval stands on record. |
| VERIFY | the executor's `verify()` | `true` gives VERIFIED; `false` gives FAILED; `null` or `undefined` (cannot be confirmed yet) leaves EXECUTED. A throw in `verify()` counts as `false`. |
| AUDIT | `AuditService.record` | DECISION_CREATED, DECISION_APPROVED / MODIFIED / REJECTED, ACTION_EXECUTED, ACTION_VERIFICATION_FAILED, ACTION_FAILED, ACTION_NO_EXECUTOR, DECISION_CANCELLED. All marked executive. |
| REPORT | `resolve()` return value; the stored Decision; an event | The API returns `{ ok, decision, execution }`. `ok` is true only for EXECUTED or VERIFIED. The execution record (`result, detail, failed_because, verified, at`) stays on the Decision. For `send_email` and `send_client_message`, `royal.resolveDecision` also publishes `MESSAGE_SENT` or `MESSAGE_FAILED` (section 6). Nothing is pushed back into the conversation. |

Decision statuses used: OPEN, APPROVED, MODIFIED, REJECTED, EXECUTED, VERIFIED, FAILED, CANCELLED. EXPIRED exists in `DECISION_STATUS` but nothing sets it: expiry is NOT IMPLEMENTED.

## 2. Approval Specificity

An approval is for one exact action, not for a kind of action.

(a) The send path computes `args_hash = emailHash({ to, subject, body })` (`core/intelligence/comms.js`: a stable hash of the lower-cased address, the subject and the body) and puts it in the Decision's arguments.

(b) The Decision's dedupe key is `"email:" + args_hash`, so its id is derived from the exact content.

(c) At execution, `emailExecutor` recomputes the hash from the draft it is about to send. If it differs and the Decision was not MODIFIED, it refuses: "The message changed after approval; nothing was sent."

(d) A MODIFIED Decision skips the hash check, because the modified arguments are themselves what Tahir approved.

## 3. Idempotency

(a) **One card per question.** `DecisionService.create` returns the existing Decision when the same dedupe key is still OPEN. Saying "send it" twice before approving gives the same Decision (TESTS A to E).

(b) **A decided action is never reopened.** When the Decision for a dedupe key is APPROVED, MODIFIED, EXECUTED or VERIFIED, `create` returns it unchanged with `already_decided: true` and writes nothing. `ConsequenceGate.request` passes `already_decided` through to the caller. The stored record is never overwritten back to OPEN (tested: "review: 'send it' after an approved send never sends twice or reopens the record", which also calls `create` directly with the same key).

(c) **A refused action may be asked again, under a new identity.** When the Decision is REJECTED, CANCELLED or FAILED, `create` tries ids derived from the dedupe key plus `"#2"`, `"#3"` and so on, and writes the new OPEN Decision under the first free one. The old record keeps its status and history. If one of those alternates is already OPEN it is returned; if one is already decided it is returned with `already_decided` (tested: "review: a rejected send may be asked again, under a new identity, keeping the old record").

(d) **One resolution.** `resolve` refuses anything not OPEN with `ALREADY_<STATUS>`; the API answers 409. A second approval sends nothing (TESTS A to E; `tests/core.test.js`, "a decision cannot be resolved twice").

(e) **No race.** The resolve write is conditional on the stored revision. A concurrent resolve gets `CONFLICT` and nothing executes.

(f) **Provider level.** Resend is called with `Idempotency-Key: royal-<decision id>`, asserted in TESTS A to E. Because a new request after a refusal gets a new Decision id (item c), it also gets a new idempotency key, and because an approved Decision is never reopened (item b), its key is never reused for a second send.

(g) **Conversation level.** `doSend` checks the draft's own `decision_id` first: if that Decision is APPROVED, MODIFIED, EXECUTED or VERIFIED it answers "That email was already sent. I won't send it twice." (or "already approved"). If the gate reports `already_decided` for the same content it says the same and marks the draft `sent` when the Decision was EXECUTED or VERIFIED.

(h) **Internal tasks.** `create_internal_task` derives its id from the source item, so a repeat returns "Task already exists."

## 4. Cancellation

**What counts as a cancellation.** `R.cancel` in `core/intelligence/intent_engine.js` matches only a bare instruction: the whole message must be "stop", "cancel", "abort", "halt", "don't send", "do not send", "never mind" or "forget it" / "forget that", optionally preceded by "please", optionally followed by "it", "that", "this", "everything" or "the email / draft / message / send / sending / update / approval / request / task / research", optionally followed by "please" and closing punctuation. "Stop the Marcus production" and "Forget it, what does Marcus owe?" are not cancellations and stay with the House (tested: "review: House sentences stay with the House; bare controls still work"). The model is never consulted for it.

"Never mind" was removed from `CLEAR` in `core/intent.js`, so it now reaches `doCancel`. `CLEAR` keeps clear, reset, start over, that's all and dismiss.

**What it withdraws.** `core/royal.js#handle` records, in the conversation field `open_decisions`, the id of every Decision this conversation raised (any answer whose surface is `decision_pending`), House client messages and outreach emails alike, keeping the last twenty. `doCancel` in `core/intelligence/index.js`:

(a) calls `DecisionService.cancel` on every id in `open_decisions`, plus the open outreach draft's `decision_id`; `cancel` changes only Decisions that are still OPEN (status CANCELLED, audited `DECISION_CANCELLED`), so anything already approved or carried out is left as it is;

(b) cancels this conversation's open AgentTasks (`AgentTasks.cancelOpen`); the bot itself is not told;

(c) closes the drafts: the outreach draft is marked `cancelled`, the House `pending_draft` is cleared, and `open_decisions` is emptied, so a later "send it" asks what to send;

(d) says exactly what happened: "Stopped. Withdrew the approval to <title>, so it won't be sent." (or "Withdrew N approvals"), plus "Cancelled N delegated tasks" when there were any; "Stopped. The draft is closed; nothing was waiting for approval." when only a draft was open; and "Nothing was waiting to be sent or done." when there was nothing at all. It never claims to have stopped something that was not there.

Tested in "TEST E (failure)" and "review: 'stop' and 'never mind' withdraw every approval this conversation asked for, House messages included" (a House client update withdrawn by "Don't send it", another by "Never mind", and "Stop" with nothing open).

The `clear` skill forgets the conversation's subject and drafts but keeps `open_decisions`, so a "stop" after "clear" can still withdraw what was asked for. `clear` itself withdraws nothing.

## 5. Replacing or Revising a Draft Withdraws a Stale Approval

(a) **Revision.** `doRevise` makes a new draft (new id, `version + 1`, `previous` pointing back). If the old draft had an open Decision, it is cancelled with the reason "the draft was revised", and the new draft carries no approval. The next "send it" hashes the new wording and raises a new Decision. Tested: the first Decision becomes CANCELLED and the second has a different id ("TEST E (failure)").

(b) **A new draft.** When `doOutreach` writes a new draft while an earlier outreach draft is still open, the earlier draft's open Decision is cancelled with the reason "replaced by a new draft" (tested: "review: a new draft withdraws the old draft's approval").

Revision uses the model when one is connected with structured output. Without one, only shortening works (`shorten()`, by rule); tone changes say the provider is needed and leave the draft unchanged.

## 6. The Email Send Flow

(a) **Draft.** The writer is chosen by `routeAgents` (`AGENT_ORCHESTRATION.md`, section 3) and drafts through the gate (`draft_email`, DRAFT class). The recipient is set only if the researched address is a business address at the company's domain (`isBusinessEmail`) and not INVALID or NOT_FOUND.

(b) **"Send it".** `doSend` needs an open draft; otherwise it asks. It then stops and asks, rather than guess, in two cases:

(i) a House client update (`pending_draft`) is also open and the words do not say email, intro, introduction, outreach or pitch: "Two messages are open: the email to X and the update for Y. Say "send the email" or "send the update"." Nothing is put up for approval. "Send the update" (or words naming the update, "message to" or "the client") goes to the House `send_pending` skill instead (`core/royal.js`);

(ii) the draft's person differs from the `active_person` now under discussion and the words do not name the draft's recipient: "The open draft is to X, but we've since been talking about Y."

Both are tested in "review: 'send it' asks when two messages are open, and when the draft is for someone else".

(c) **Already decided.** See section 3, item (g).

(d) **The Decision.** With an address, `doSend` requests `send_email` as `royal`. The Decision is type SEND_EXTERNAL_EMAIL, priority P2, risk ORANGE when the address is not VERIFIED_DELIVERABLE or PUBLICLY_LISTED (YELLOW otherwise), with the full subject and body in its description and "One email, exactly as shown" as the expected result. Without an address it asks for one.

(e) **Executor registration.** `core/royal.js` registers `emailExecutor` for `send_email` only when flag `agent_external_send` is on and `ResendEmailProvider.configured()` (both `RESEND_API_KEY` and `ROYAL_EMAIL_FROM`). Flags are read once, when ROYAL is built.

(f) **Send.** One call: `POST https://api.resend.com/emails` with headers `Authorization: Bearer <RESEND_API_KEY>`, `Content-Type: application/json` and `Idempotency-Key: royal-<decision id>`, body `{ from, to: [address], subject, text }`, 20 second timeout. It counts as sent only if the HTTP status is OK and the reply has an `id`. Otherwise `EMAIL_PROVIDER_HTTP_<status>` or `EMAIL_PROVIDER_UNREACHABLE`, recorded as FAILED.

(g) **Verify.** Immediately after, `GET https://api.resend.com/emails/<id>` (15 second timeout). `verify()` returns `true` only when Resend's `last_event` is "delivered"; `false` when it is bounced, failed or complained; `null` for anything else ("sent", "queued", "delivery_delayed", an unreadable reply). So VERIFIED means delivered, FAILED means the provider reported a bounce, failure or complaint, and EXECUTED means accepted by Resend but not yet confirmed. The read-back happens immediately, so any send not yet delivered at that moment ends EXECUTED (tested per event in "review: email is verified only when the provider says delivered"). A later delivery or bounce is not observed: Resend webhooks are NOT IMPLEMENTED, so an EXECUTED Decision is never upgraded or downgraded afterwards.

(h) **Report.** The execution detail reads "Accepted by resend as message <id> at <time>." TESTS A to E assert exactly one POST, the idempotency header, the approved (shortened) wording in the body, and a final status of VERIFIED against a fake that reports "delivered".

(i) **Event.** `royal.resolveDecision` publishes `MESSAGE_SENT` when the execution result is EXECUTED and `MESSAGE_FAILED` when it failed, with the Decision id, tool, status and `verified`. The type follows the execution result, not verification: a send that Resend accepted and then reported bounced is published as `MESSAGE_SENT` with `status: "FAILED"` and `verified: false`. No event is published for NO_EXECUTOR or REJECT.

## 7. When Sending Is Disabled or Not Configured

(a) Flag off (the default), or keys missing: there is no executor. "Send it" still raises the Decision, and ROYAL says "Email sending isn't connected yet, so approving records the decision and nothing is sent."

(b) Approving it records DECISION_APPROVED, then `NO_EXECUTOR` with "A person carries this out. The approval is recorded." The Decision stays APPROVED. Tested in "TEST E (failure)".

(c) No Resend call of any kind is made, and no message event is published.

## 8. Voice

Approval is never by voice. The realtime voice session is told "Approvals happen on screen, never by voice" (`server/handler.js#voiceSessionConfig`), and each `ask_royal` reply tells it not to claim anything was sent (`web/js/realtime.js`). Realtime voice is offered on the Business side only. See `VOICE_ARCHITECTURE.md`.

## 9. Known Gaps

(a) The House `send_pending` skill (`skills/index.js`) ignores `already_decided`. After a House client message is approved, preparing the same message again and saying "send it" returns the approved Decision while the reply still says it "needs your approval. It's in front of you now." Its dedupe key is `send:<project>:<body length>:<purpose>`, so a later, different update of the same length and purpose for the same project also collides with the approved one and can never be raised on its own.

(b) `DecisionService.create` tries alternate ids up to `#49`. If all of them are taken by refused Decisions, the loop ends and the new OPEN Decision is written over the original refused record.
