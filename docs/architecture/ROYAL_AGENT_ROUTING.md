# ROYAL AGENT ROUTING

*Sources: `core/intelligence/agents.js` (`routeAgents`, `adapterFor`), `core/registry.js`.*

## 1. Two kinds of specialist

(a) **Native specialists** run inside ROYAL: ACE (pipeline, follow-up, qualification, outreach, prospecting), GRACE (production, client updates, pickup, QC), LEDGER (receivables, cash, margins, leakage) and FORGE (connector health, data integrity). They are deterministic, read the calculator snapshot through the permission gate, run in parallel with an 8 second deadline, and answer in milliseconds. HOUSE (content, campaigns, brand) has no native specialist yet.

(b) **Grok Bots** are external teammates reached through the bridge (`core/grokbot/`): a webhook out, the bot's own events back. Slow and asynchronous by nature.

## 2. When ROYAL uses which

(a) **No specialist** for world facts, arithmetic, House policy, research and simple reads: ROYAL answers directly.

(b) **Native first.** When a capability is needed and its specialist is ACTIVE, the native specialist does it.

(c) **Grok Bot** only when the native specialist cannot do the work (HOUSE today), the flag `advanced_agent_orchestration` is on, and the bot is configured. A bot is never asked for raw data a native read can return faster.

(d) **Named by Tahir** ("have GRACE prepare an update"): that specialist, through whichever adapter is available.

## 3. Why this split

Speed: native specialists answer in milliseconds; a Grok Bot round trip is a webhook plus whenever the bot replies. Durable bot environments are kept for work that needs them (long-running, browser or app work).

## 4. Update, 1 October 2026

(a) **Questions about the team** ("what did each bot do today", "what did ACE do", "what are you working on", "diagnose yourself") are answered from ROYAL's records (`teamRoute()` in `core/router.js`), never by searching the web and never by asking the bots to vouch for themselves.

(b) **HOUSE** has no native runtime; a native consult reports it NOT_CONNECTED with that reason instead of throwing.

(c) **No delegation into a broken bot:** a bot whose connection is AUTH_FAILED or FAILED is not sent work; ROYAL says why.

(d) Orchestration details: `ROYAL_AGENT_ORCHESTRATOR.md`.
