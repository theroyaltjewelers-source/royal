# ROYAL: INTERACTION ARCHITECTURE

*Replaces the dashboard interface. Written 30 September 2026 with the rebuild it describes.*

## 1. The idea

ROYAL is one presence, not a set of screens. Tahir touches it, speaks to it or types to it, and it answers in words and, when words are not enough, with objects placed around it. When nothing needs him, ROYAL is a quiet light and nothing else.

Three rules shape everything below.

(a) **Ambient first.** The resting screen is the Core, a line of state and three small marks. There is no permanent navigation, no dashboard and no ask bar. Infrastructure appears only when it is relevant (a specialist that took part, a system that is down, a decision that is waiting).

(b) **Truth before beauty.** Every visible state is a state the system is actually in. Agent nodes appear only for specialists that really reported. The start-up sequence shows only what the server reports. Nothing is invented to fill a surface.

(c) **The model never draws.** The server turns a verified result into a presentation spec made only of known primitives, validates it, and sends it. The page renders primitives it knows. A model's text can become, at most, a STATEMENT labelled as inference.

## 2. The pieces

| Piece | Where | Job |
|---|---|---|
| Intent grammar | `core/intent.js` | Control verbs (clear, back, send it, have X prepare) and follow-ups about the entity in focus, before the general router. |
| Conversation context | `core/context.js`, `core/royal.js` | The entity in focus, pronoun resolution ("he", "the client"), and the pending draft that "send it" refers to. Kept per conversation and per realm. |
| UI Composer | `core/composer.js` | Result to presentation spec. See UI_COMPOSER.md. |
| Primitive schema | `web/js/schema.js` | One schema shared by server and page. See UI_PRIMITIVES.md. |
| State machine | `web/js/state.js` | What ROYAL is doing; legal transitions only. See ROYAL_CORE_STATE_MACHINE.md. |
| Core | `web/js/core.js` | The living light: WebGL shader, 2D fallback, quality tiers. |
| Stage | `web/js/stage.js` | Layout, objects materializing and receding, agent nodes, history. |
| Voice | `web/js/voice.js` | Listening, speaking, barge-in, mute. See VOICE_ARCHITECTURE.md. |
| Sound | `web/js/sound.js` | Quiet cues and haptics, one meaning each. |
| App | `web/js/app.js` | Wiring, sign-in, start-up, menu sheet, decisions. |

## 3. One exchange, end to end

(a) Tahir touches the Core. The state goes AMBIENT to AWAKE, a wake cue plays, ROYAL greets him ("Evening, Tahir."), and, where the browser supports speech input, starts listening (LISTENING). The microphone level moves the Core.

(b) He says "Pull up Marcus." His words appear above the caption as he speaks. On the final transcript the state goes UNDERSTANDING, then THINKING while the request is in flight.

(c) The server interprets the words (`intent.js`), resolves Marcus Hill's project, consults GRACE, ACE and LEDGER through the permission gate, and composes a spec: an ENTITY_CORE object plus the open items on that project, with the agents that reported.

(d) Because specialists took part, the state goes DELEGATING and a node appears for each, joined to the Core by a beam. The nodes say "reported". They were not shown before the answer arrived, because until then ROYAL could not truthfully say who would report.

(e) RESPONDING: the Core rises, the objects materialize in order, the caption shows ROYAL's sentence and ROYAL speaks it. Tahir can interrupt at any moment by touching the Core, typing or speaking.

(f) The answer ends in the state it deserves: COMPLETE, WARNING if the answer is serious, WAITING_FOR_APPROVAL if a decision is open, FAILURE if something could not be done. After forty quiet seconds ROYAL returns to AMBIENT; after a longer quiet spell the objects recede too, except an open decision.

(g) "What does he owe?" resolves "he" to the project in focus. "Have GRACE prepare an update" produces a draft (nothing sent). "Send it" turns that draft into a Decision, because sending to a client needs approval. Approve, Edit, Reject and Ask ROYAL sit on the decision itself. A spoken "yes" never approves anything.

## 4. What the page never does

(a) Hold business state. It asks the API every time.

(b) Decide authority. Approvals are resolved on the server by an owner; the page only shows buttons.

(c) Pretend. Where speech input is missing it says so and offers typing. Where a specialist or system is not connected it says NOT CONNECTED. Where the renderer cannot draw WebGL it draws the 2D Core and says so in Systems.

(d) Show secrets. There are none in `web/`; a test checks.

## 5. Business and Personal

The realm is chosen in the menu. Switching starts a new conversation, clears the stage and history, and changes the label. Every request carries the realm and the server enforces the separation (ADR-009). The interface only reflects it.

## 6. Known limits

(a) Speech recognition is the browser's own. In Chrome and Edge audio goes to the browser vendor's speech service. Safari on iOS supports it from recent versions; Firefox does not. Typing always works.

(b) Speech output uses the device's voices, which vary in quality.

(c) Agent nodes replay what happened during the request; they are not a live stream of the specialists' work, because the server answers in one response. A streaming transport would let them appear as each specialist reports.
