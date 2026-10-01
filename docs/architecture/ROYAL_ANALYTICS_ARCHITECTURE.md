# ROYAL ANALYTICS ARCHITECTURE

**Rule:** metrics are computed by code from House records; a model may interpret them, never invent them.

**Available now (current state, from the calculator snapshot and its treasury):** receivables and who owes them, balances on finished pieces, production running ahead of payment, overdue bills, the calculator's own runway, revenue leakage findings, stage exceptions, commitments due, pipeline at Inquiry, and congruence checks. All deterministic, answered with no model call.

**Not available yet:** cycle time by category, stage aging over time, vendor lateness, lead conversion, deposit conversion, payment-promise reliability, client-update compliance, rework rate, profit by project type over time. Each needs history (stage timestamps, payment dates, vendor dates, lead outcomes) that the calculator does not send today (`CLAUDE.md`, known-wrong (c)). With the Postgres store (ADR-013) snapshots and events persist, so trend queries become possible once that history arrives.

**Agent completion rate** is available per day from the agent activity ledger.
