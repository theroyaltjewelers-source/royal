# ROYAL HOUSE LANGUAGE

*Source: `core/house_language.js`, version 2026-10-01.*

## 1. What it is

The words The House of Royal T uses, what each means, and where the meaning comes from. Every entry has a House source: the Company Bible, Article VI (the commission lifecycle) and Article II, or the Project Calculator's stage list. A term with no House source is not in the registry; ROYAL says it has no House definition rather than inventing one.

## 2. Entries

Inquiry, Qualification, Consultation, Design deposit, CAD, CAD approval, Production deposit, Materials and stones, Manufacturing and setting, Quality control, Final payment, Pickup or shipping, Aftercare, The House of Royal T, Commission; and the calculator stages in order: Inquiry, Design, CAD, Awaiting approval, Deposit due, Production, Quality control, Balance due, Ready, Delivered, Archived. Synonyms are listed per entry (for example QC, casting, project).

## 3. Open questions for Tahir

The Company Bible marks these [TAHIR TO CONFIRM], and ROYAL says so when asked: (a) whether the ACE to GRACE handoff happens at the design deposit or at the signed order; (b) the percentage or amount of each of the three deposit stages. No definition exists yet for "CAD complete" or "waiting for payment".

## 4. How it is used

(a) **Definitions** ("What does production deposit mean?", "What's the difference between CAD approval and a design deposit?") are answered at once from the registry, labelled VERIFIED_INTERNAL with their source.

(b) **Definition is not state.** "What's Marcus's balance?" is a question about a record and goes to the calculator. Only definitional phrasing reaches the registry.

(c) **In prompts:** `houseLanguagePrompt()` follows the identity on every model prompt, so ROYAL uses the House's words naturally ("It's still in stone setting"), not as a taxonomy.

## 5. Adding a term

Add it to `LIFECYCLE` or `HOUSE_WORDS` in `core/house_language.js` with its definition, synonyms and the source it came from. A term without a source does not belong here.
