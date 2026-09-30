# ROYAL

The unified intelligence and command layer for Tahir: one intelligence over his Business realm (The House of Royal T, Tahir & Co., Gold Buy, Operations) and his Personal realm (Wealth, Calendar, Personal tasks).

ROYAL is not the database. It reasons over verified facts from the systems that own them, starting with the Royal T Project Calculator. It enforces authority in code, and it never manufactures certainty.

## Run It Locally

```
node --version            # 20 or later; there is nothing to install
npm test                  # 72 tests, zero dependencies
ROYAL_DEV_OWNER_TOKEN=dev ROYAL_STORE_PATH=./royal.json node server/node.js
# open http://localhost:8787, choose "Development token", enter: dev
```

To see it with data, post a House API snapshot to `/v1/ingest/calculator` (the calculator does this itself once `ROYAL_URL` is set), or run the contract test against a calculator checkout:

```
RTJ_CALCULATOR_DIR=../royal-t RTJ_SEED=/tmp/seed.js node --test tests/
```

## Layout

```
core/                 orchestrator, registry, permissions, gate, decisions, audit, store,
                      sources, context, router, attention, events, providers
realms/business/royal-t/
                      contract (rtj.house.v1), connector, specialists (ACE GRACE LEDGER FORGE), changes
skills/               the skill library and client-message drafts
server/               fetch-standard handler; Node and Deno entries
web/                  the ROYAL app, and royal-embed.js (vendored into the calculator)
docs/                 company, agents, training, skills, architecture
tests/                node:test suites
```

## Ask It

"What needs me?", "State of the House", "Can I step away?", "Who owes us money?", "What are we waiting on?", "Which promises are due?", "What changed today?", "Why hasn't Marcus's chain moved?", then "Handle it."

## Read First

`docs/architecture/ROYAL_ARCHITECTURE.md`, `PERMISSION_MODEL.md`, `DECISIONS.md`, and `CLAUDE.md` for the working rules.
