# ROYAL SYSTEM CONGRUENCE

*Source: `core/congruence.js`.*

## 1. What is checked

The calculator snapshot is ROYAL's one structured source of House state, and it states some facts twice. `congruence(snapshot)` checks:

(a) **RECEIVABLE_MISMATCH:** the treasury's receivable against the sum of project balances.

(b) **PAYABLE_MISMATCH:** the treasury's payable total against the overdue bills it lists.

(c) **PROJECT_BALANCE_MISMATCH:** a project's value less paid against its stated balance.

(d) **MISSING_CLIENT:** a project pointing to a client the snapshot does not contain.

(e) **POSSIBLE_DUPLICATE_CLIENT:** two client records with the same name.

A one-dollar tolerance absorbs rounding. Nothing recomputes price, margin, value or runway.

## 2. What happens

A conflict is reported, never silently resolved: in the cash answer ("Two things don't add up... I haven't picked one side") and in self-diagnosis (Data congruence: DEGRADED, with each issue). The sample data in `tests/fixtures.js` shows two real conflicts of this kind ($30,400 against $30,900 receivable; $0 payables beside a $1,850 overdue bill).

## 3. Across systems

Grok Bots report free text, not structured state, so their claims cannot be compared field by field with the calculator; they stay REPORTED. When a second structured system (CRM, accounting) is connected, its facts map to the ontology (`HOUSE_ONTOLOGY.md`) and are compared the same way.
