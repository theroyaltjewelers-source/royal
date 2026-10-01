# ROYAL EXECUTIVE KNOWLEDGE FABRIC

*Sources: `docs/knowledge/`, `core/intelligence/knowledge.js`, `fromFabric()` in `core/intelligence/index.js`.*

## 1. Packs

| Pack | File | Scope |
|---|---|---|
| CEO | `ceo.md` | strategy, advantage, capital allocation, prioritization, decisions, unit economics, organization, cadence, risk, governance |
| CFO | `cfo.md` | cash versus profit, working capital, A/R, margins, break-even, forecasting, project profitability, pricing, returns, liquidity, controls |
| Accounting | `accounting.md` | `ROYAL_ACCOUNTING_KNOWLEDGE.md` |
| CTO | `cto.md` | design, APIs, idempotency, events, data, reliability, observability, security, AI systems, debt, build versus buy |
| COO | `coo.md` | process, constraints, cycle time, queues, quality, vendors, procurement, SOPs, KPIs, project management |
| CMO | `cmo.md` | positioning, brand equity, luxury, content, campaigns, channels, lifecycle, attribution, segmentation |
| CRO | `cro.md` | pipeline, qualification, discovery, relationship selling, objections, follow-up, closing, forecasting, CRM |
| Jewelry | `jewelry.md` | gold purity, metals, weights, the 4Cs, lab-grown, hardness, manufacturing, setting |
| Map | `other_domains.md` | named domains not yet written; the live-source rule for law, tax and regulation |

## 2. Metadata

Each pack opens with a Metadata section: document_id, domain, subdomains, source, source_type (curated_reference), author, dates, version, authority_level, license (original text), freshness_class, benchmark questions. It is kept with the document (`docs.get(path).meta`) and not searched.

## 3. Rules

(a) Indexed in their own namespace `fabric`, scored at 0.6 of House documents, never searched for House policy or offers. (b) Concept questions are routed to knowledge (`CONCEPT` in `core/router.js`) even with House words in them; one naming a House record stays with the House. (c) With a model: one grounded call over the passages. Without: the passage itself. Either way labelled "from my business reference (general knowledge, not House policy)". (d) Law, tax and regulation are always researched from current official sources. (e) Original text written for the House, not copied from books; to be reviewed by Tahir before it guides policy.

## 4. Evaluated

`tests/knowledge_fabric.test.js`: 14 benchmark questions across the packs answered from the right pack with no model; House policy outranks the reference; metadata not searchable; tax and law to live research.
