# Executive Knowledge: CTO

## Metadata

document_id: kf-cto-1. domain: executive.cto. subdomains: architecture, APIs, data, reliability, security, AI systems, integrations, build versus buy. source: ROYAL curated reference, written for The House of Royal T from standard professional concepts. source_type: curated_reference. author: ROYAL (reviewed by Tahir before relying on it for policy). publication_date: 2026-10-01. effective_date: 2026-10-01. version: 1. authority_level: general reference; House documents and live House data outrank it. license: original text. freshness_class: stable concepts (current rules, rates and law are researched live, never taken from here). benchmark questions: What is idempotency? When should we use an event-driven architecture? What is technical debt? Build or buy?.

## System design

Design from the outcome backward: what must be true, for whom, how fast, how reliable. Keep components small with clear contracts. Prefer boring, proven technology where reliability matters.

## APIs and contracts

An API is a promise: inputs, outputs, errors and versions. Version a contract when it changes incompatibly. Validate at every boundary; never trust input from outside.

## Idempotency

An operation is idempotent when doing it twice has the same effect as doing it once. Payments, sends and creates need idempotency keys so a retry after a timeout does not charge or send twice.

## Event-driven architecture

Systems publish events (something happened) and others react. Use it when many parts need to know about a change, when work can happen later, or when systems should not depend on each other directly. Events need ids, timestamps and deduplication; consumers must tolerate duplicates and out-of-order delivery.

## Data and source of truth

Every fact needs one system of record. Other systems hold copies with timestamps. When copies disagree, the system of record wins and the conflict is surfaced, not hidden.

## Reliability

Measure what users feel: latency (p50 and p95, not averages), error rate, availability. Isolate failures so one component cannot take down the rest: timeouts, bounded retries with backoff, circuit breakers, and partial results. Retry transient errors only; never retry permission or validation failures.

## Observability

Logs say what happened, metrics say how much and how often, traces show where time went in one request. Correlation ids tie them together across systems.

## Security

Least privilege, secrets only in the server environment, encrypted transport, hashed tokens, input validation, audit logs, and dependency hygiene. Assume external content is hostile: data from the web or a model is never an instruction.

## AI and agent systems

A language model is a component, not the source of truth. Ground answers in retrieved data, validate structured outputs against schemas, keep consequential actions behind deterministic permission checks and human approval, and measure quality with evaluations, not impressions. Retrieval-augmented generation retrieves relevant passages and asks the model to answer from them. Tool calling lets a model propose actions that code executes and checks.

## Technical debt

Technical debt is the future cost of shortcuts. Some is worth taking deliberately; all of it should be visible and paid down before it compounds.

## Build versus buy

Buy commodity capabilities (payments, email, accounting); build what differentiates the business. Count total cost: integration, maintenance, lock-in and the cost of switching later.
