# SETTING UP A GROK BOT TO WORK WITH ROYAL

*1 October 2026. For Tahir. What each Grok Bot (ACE, GRACE, LEDGER, HOUSE, FORGE) needs so ROYAL can talk to it from the main conversation.*

## What changes for you

You no longer open the Bots panel to get a bot working. Ask ROYAL: "Ask GRACE what's holding Marcus's project", "Have GRACE and LEDGER look at Marcus together", "Talk to each of the bots and tell me what they worked on today". ROYAL sends the work to the bot, and the bot's answer comes back to the same conversation. If a bot takes longer than about 12 seconds, ROYAL says "I sent that to GRACE. I'll bring the answer here when it comes", and shows the answer when it arrives.

The Bots panel is still there for checking a bot, its history, and sending it a message directly while debugging.

## What each bot needs

(a) **Its webhook in Render.** In Render, Environment, for each bot:
`GROKBOT_ENABLED=true`, `GROKBOT_BOTS=ace,grace,ledger,house,forge` (add `skill_library` and others if you use them), and `GROKBOT_<NAME>_WEBHOOK_URL` and `GROKBOT_<NAME>_WEBHOOK_KEY` for each (for example `GROKBOT_LEDGER_WEBHOOK_URL`). LEDGER and FORGE were not in the default list before; add them.

(b) **Its token.** In ROYAL, open Bots, choose the bot, Token, Issue new token, and paste it into that bot's secure secret setting. The bot uses it to answer ROYAL.

(c) **Its instructions.** Add this to each bot's instructions, with its own name:

> When a message from ROYAL arrives, it contains `task_id:`, `handoff_id:` and sometimes `nonce:` lines, and a `request_id`. Do the work it asks, then post ONE event to your reply endpoint (`/v1/bots/<your id>/events`) with your ROYAL token, `"type": "result"`, the same `request_id`, and in `content_markdown` a ```json block with: `agent_id` (your id), `task_id`, `handoff_id` (copied exactly), `nonce`, `name` and `role` if a nonce was given, `status` (REPORTED_COMPLETE, PARTIAL, FAILED or WAITING), `summary`, and the lists `findings`, `sources`, `actions_taken`, `artifacts`, `next_actions`, `unresolved_questions`, plus `requires_tahir`, `requires_approval` and `requested_specialist` (another specialist you need, or null). Never send messages, move money, change prices or production, publish, delete or deploy: propose those in `next_actions`, and Tahir approves them through ROYAL.

Every message ROYAL sends already ends with these instructions and the exact JSON shape, so a bot that follows its messages will answer correctly.

## Checking a bot

In Bots, press "Check connection". ROYAL sends a connection test with a one-time nonce. The bot shows "Connected, verified" only when it answers with its own token, its name, its role and that exact nonce. A reply in prose only does not count.

To check all five from the conversation, run on a computer with this repository:

    ROYAL_URL=https://royal-1wx5.onrender.com ROYAL_TOKEN=<your session token> npm run phase1:verify

The LIVE_ROYAL_TO_BOT line passes only when each of the five answered a connection test and an "Ask <name> …" question asked the normal way, with the answer coming back to the conversation.

## What a bot can and cannot do through ROYAL

A bot can analyse, research, read what ROYAL gives it and prepare work. Its report is shown as its report ("GRACE came back: …"), never as verified fact. Anything consequential it proposes (an email, a refund, a price, a production change) is shown to you and done only if you ask ROYAL, through the usual approval.
