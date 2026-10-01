/* The House language: the words The House of Royal T uses, what each means,
   and where that meaning comes from.

   Every definition here is taken from a House source: the Company Bible
   (docs/company/HOUSE_COMPANY_BIBLE.md, Article VI, the commission
   lifecycle) or the Project Calculator's own stage list
   (realms/business/royal-t/contract.js, STAGES).  Where the Bible marks
   something [TAHIR TO CONFIRM], the entry says so and nothing is filled in.
   A term with no House source is not in this registry; ROYAL says it has no
   House definition for it rather than inventing one.

   Definitions are House knowledge, not House state: "what does production
   deposit mean" is answered here; "is Marcus's production deposit paid"
   comes from the calculator. */

import { STAGES } from "../realms/business/royal-t/contract.js";

const BIBLE = "Company Bible, Article VI";
export const HOUSE_LANGUAGE_VERSION = "2026-10-01";

/* Lifecycle terms, in the Bible's order. */
const LIFECYCLE = [
  { term: "inquiry", say: "Inquiry", def: "a prospective client reaches the House", owner: "ACE", src: "VI(a)" },
  { term: "qualification", say: "Qualification", def: "the House determines fit, budget, timeline and tier", owner: "ACE", src: "VI(b)" },
  { term: "consultation", say: "Consultation", def: "the private appointment where the piece is defined", owner: "ACE", src: "VI(c)", synonyms: ["design consultation"] },
  { term: "design deposit", say: "Design deposit", def: "the first of the House's three deposit stages; ACE hands the client to GRACE here", owner: "ACE", src: "VI(d)",
    confirm: "whether the handoff happens at the design deposit or at the signed order" },
  { term: "cad", say: "CAD", def: "the design model produced and presented to the client during design", owner: "GRACE", src: "VI(e)", synonyms: ["design and cad", "cad design"] },
  { term: "cad approval", say: "CAD approval", def: "the client approving the design, in a recorded form", owner: "GRACE", src: "VI(f)", synonyms: ["cad approved", "design approval"] },
  { term: "production deposit", say: "Production deposit", def: "the second of the three deposit stages, taken before production", owner: "LEDGER", src: "VI(g)",
    confirm: "the percentage or amount for each of the three deposit stages" },
  { term: "materials and stones", say: "Materials and stones", def: "sourcing the metal, stones and components", owner: "GRACE", src: "VI(h)" },
  { term: "setting", say: "Manufacturing and setting", def: "casting or fabrication, then stone setting", owner: "GRACE", src: "VI(i)", synonyms: ["casting", "stone setting", "manufacturing"] },
  { term: "quality control", say: "Quality control", def: "inspecting the piece against the approved design and House standards", owner: "GRACE", src: "VI(j)", synonyms: ["qc"] },
  { term: "final payment", say: "Final payment", def: "the third deposit stage, the balance; LEDGER verifies it", owner: "LEDGER", src: "VI(k)", synonyms: ["balance payment"] },
  { term: "pickup or shipping", say: "Pickup or shipping", def: "delivering the piece to the client, with authentication where it applies", owner: "GRACE", src: "VI(l)",
    synonyms: ["pickup", "shipping", "delivery"] },
  { term: "aftercare", say: "Aftercare", def: "service, resizing, cleaning and continuing the relationship", owner: "GRACE", src: "VI(m)" },
].map((e) => ({ ...e, source: BIBLE + "(" + e.src.replace(/^VI\(|\)$/g, "") + ")" }));

const HOUSE_WORDS = [
  { term: "the house", say: "The House of Royal T", def: "the whole operating organization, including its brands and business lines; a private, appointment-only custom luxury jewelry design house for bespoke fine jewelry, custom grillz and diamond-set timepieces",
    source: "Company Bible, Article II(c) and (d)", synonyms: ["house of royal t", "the house of royal t"] },
  { term: "commission", say: "Commission", def: "a custom piece made for a client, followed from inquiry to aftercare", source: BIBLE, synonyms: ["project", "custom piece"] },
];

/* Calculator stages: their meaning is their place in the calculator's flow. */
const STAGE_WORDS = STAGES.map((s, i) => ({ term: s.toLowerCase(), say: s, stage: true,
  def: "a stage in the Project Calculator" + (i ? ", after " + STAGES[i - 1] : ", the first") + (i < STAGES.length - 1 ? " and before " + STAGES[i + 1] : ", the last"),
  source: "Project Calculator stages" }));

export const HOUSE_LANGUAGE = LIFECYCLE.concat(HOUSE_WORDS);
const ALL = HOUSE_LANGUAGE.concat(STAGE_WORDS.filter((s) => !HOUSE_LANGUAGE.some((h) => h.term === s.term)));

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const namesOf = (e) => [e.term].concat(e.synonyms || []);

export function lookupTerm(phrase) {
  const p = norm(phrase).replace(/^(a|an|the|our|a house|house)\s+/, "");
  return ALL.find((e) => namesOf(e).some((n) => norm(n) === p)) || null;
}

/* Is this a question about what a House word means?  Only definitional
   phrasing counts, so "what's Marcus's balance" stays a question about a
   record.  Returns the terms asked about and any phrase with no House
   definition, or null. */
const DEF_PATTERNS = [
  /^what (?:does|do) (?:the term |the word |we mean by )?["“']?(.+?)["”']? (?:mean|stand for)\b/,
  /^what do we mean (?:by|when we say|when something is) ["“']?(.+?)["”']?$/,
  /^(?:define|definition of|meaning of|explain what) ["“']?(.+?)["”']?(?: means| is)?$/,
  /^what(?:'s| is) the difference between ["“']?(.+?)["”']? and ["“']?(.+?)["”']?$/,
  /^when is (?:a |the )?(?:project|piece|commission) (?:considered )?["“']?(.+?)["”']?$/,
];
export function definitionQuery(text) {
  const t = String(text || "").toLowerCase().replace(/[?!.]+\s*$/, "").replace(/^\s*(royal,?\s*)/, "").trim();
  for (const re of DEF_PATTERNS) {
    const m = re.exec(t);
    if (!m) continue;
    const asked = m.slice(1).filter(Boolean).map((x) => x.replace(/^(a|an|the)\s+/, "").trim());
    const found = asked.map((a) => ({ asked: a, entry: lookupTerm(a) }));
    if (!found.some((f) => f.entry)) continue;   /* not a House word here; another pattern may still read it */
    return { terms: found.filter((f) => f.entry).map((f) => f.entry), unknown: found.filter((f) => !f.entry).map((f) => f.asked) };
  }
  return null;   /* not a House word: research or the model takes it */
}

/* The stable block every model prompt carries, after ROYAL's identity. */
export function houseLanguagePrompt() {
  return "HOUSE LANGUAGE (use these words naturally; never recite them):\n" +
    HOUSE_LANGUAGE.map((e) => "- " + e.say + ": " + e.def + (e.confirm ? " (not yet confirmed by Tahir: " + e.confirm + ")" : "")).join("\n") +
    "\n- Project Calculator stages, in order: " + STAGES.join(", ") + ".";
}
