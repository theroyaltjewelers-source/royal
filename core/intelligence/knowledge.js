/* The House Knowledge Engine (institutional memory).

   Ingests the House's own documents (Company Bible, Policy Manual, agent
   constitutions, skills, real-case training), cuts them into sections and
   policy blocks, and retrieves the few passages a question needs, with the
   document, section, version and policy status attached.  Nothing is ever
   stuffed wholesale into a prompt.

   Retrieval is keyword ranking (BM25 with light stemming).  A provider with
   embeddings could add a semantic ranker behind the same search() call; none
   is configured, so none is claimed.

   Policies carry their status from the Manual (ACTIVE, DRAFT, NEEDS_TAHIR).
   Only ACTIVE policies bind; the others are reported as not yet decided.
   A section marked SUPERSEDED is kept for history and excluded by default. */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { stableHash } from "../util.js";

export const NAMESPACES = Object.freeze({
  "company/HOUSE_COMPANY_BIBLE.md": "company",
  "company/HOUSE_POLICY_MANUAL.md": "policies",
  "agents/": "agents",
  "skills/": "skills",
  "training/": "real_cases",
  "knowledge/": "fabric",   /* the executive knowledge fabric: general reference, below House documents */
});
export const HOUSE_NAMESPACES = ["company", "policies", "agents", "skills", "real_cases"];

const STOP = new Set("a an and are as at be but by can do does for from has have how i in is it its me my of on or our so that the their them then there these this to us was we what when where which who why will with you your about into than too very just also any each only own same other such no nor not should would could think tell explain".split(" "));
function stem(w) {
  return w.replace(/'s$/, "").replace(/(ies)$/, "y").replace(/(sses)$/, "ss").replace(/([^s])s$/, "$1").replace(/(ing|ed)$/, "").replace(/(ment|ness)$/, "");
}
/* Abbreviations that would vanish when split ("a/r" becomes two letters). */
const ABBREV = [[/\ba\/r\b/g, " receivable "], [/\ba\/p\b/g, " payable "], [/\bcogs\b/g, " cost goods sold "], [/\bp&l\b/g, " income statement "], [/\broi\b/g, " roi return "], [/\broas\b/g, " roas advertising "]];
export function terms(text) {
  let s = String(text || "").toLowerCase();
  for (const [re, w] of ABBREV) s = s.replace(re, w);
  return s.replace(/[^a-z0-9%$\s-]/g, " ").split(/[\s-]+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem).filter(Boolean);
}

function namespaceOf(rel) {
  for (const [k, v] of Object.entries(NAMESPACES)) if (rel === k || rel.startsWith(k)) return v;
  return "general";
}

/* Split a Markdown document into retrievable passages. */
/* Splits long text into pieces of at most `max` characters, at line breaks
   where possible, then at sentence or word breaks.  Nothing is dropped. */
export function splitText(text, max) {
  const out = []; let cur = "";
  const push = (piece) => { if (piece.trim()) out.push(piece); };
  for (const line of String(text).split("\n")) {
    if (cur && cur.length + 1 + line.length > max) { push(cur); cur = ""; }
    if (line.length <= max) { cur = cur ? cur + "\n" + line : line; continue; }
    let rest = line;
    while (rest.length > max) {
      let cut = rest.lastIndexOf(". ", max); if (cut < max / 2) cut = rest.lastIndexOf(" ", max); if (cut < max / 2) cut = max;
      push(rest.slice(0, cut + 1)); rest = rest.slice(cut + 1);
    }
    cur = rest;
  }
  push(cur);
  return out;
}

export function chunkMarkdown(md, { path, namespace, version, updated_at }) {
  const lines = String(md).replace(/\r\n?/g, "\n").split("\n");
  const title = ((lines.find((l) => /^#\s+/.test(l)) || "").replace(/^#\s+/, "") || path).trim();
  const docStatus = (/^Status:\s*([A-Z_]+)/m.exec(md) || [])[1] || null;
  const out = []; let section = ""; let buf = []; let policy = null;
  const flush = () => {
    const text = buf.join("\n").trim(); buf = [];
    if (!text || text.length < 20) { policy = null; return; }
    const superseded = /\bSUPERSEDED\b/.test(section) || /\bStatus:\s*SUPERSEDED\b/.test(text);
    const pieces = text.length > 1600 ? splitText(text, 1400) : [text];
    for (const piece of pieces) {
      out.push({ id: "kn_" + stableHash([path, section, policy && policy.id, piece.slice(0, 80)]), path, namespace, title, section, text: piece.trim(),
        policy_id: policy ? policy.id : null, policy_status: policy ? policy.status : null, doc_status: docStatus, superseded, version, updated_at,
        synthetic: namespace === "real_cases" });
    }
    policy = null;
  };
  for (const l of lines) {
    const h = /^(#{2,3})\s+(.+)$/.exec(l);
    if (h) { flush(); section = h[2].trim(); continue; }
    const p = /^\*\*(POL-[A-Z]+-\d+)\s+([^*]+?)\.?\*\*\s*(Status:\s*([A-Z_]+))?/.exec(l);
    if (p) { flush(); policy = { id: p[1], status: p[4] || null }; buf.push(l); continue; }
    if (/^---\s*$/.test(l)) { flush(); continue; }
    buf.push(l);
  }
  flush();
  return out;
}

export class KnowledgeEngine {
  constructor() { this.chunks = []; this.df = new Map(); this.avgLen = 0; this.docs = new Map(); }

  async ingestDir(root, { include = ["company", "agents", "skills", "training", "knowledge"] } = {}) {
    const files = [];
    for (const dir of include) {
      let names = []; try { names = await readdir(join(root, dir)); } catch (_) { continue; }
      for (const n of names) if (n.endsWith(".md")) files.push(join(root, dir, n));
    }
    for (const f of files) {
      const md = await readFile(f, "utf8"), st = await stat(f);
      this.add(relative(root, f).replace(/\\/g, "/"), md, { updated_at: st.mtimeMs });
    }
    return this.stats();
  }

  /* Add or replace one document.  Its previous version's passages go. */
  add(path, md, { updated_at = Date.now(), namespace = namespaceOf(path) } = {}) {
    const version = "v-" + stableHash(md).slice(0, 10);
    this.chunks = this.chunks.filter((c) => c.path !== path);
    let cs = chunkMarkdown(md, { path, namespace, version, updated_at });
    /* A reference document's metadata describes it; it is kept with the
       document, not searched as if it were an answer. */
    let meta = null;
    if (namespace === "fabric") {
      const m = cs.find((c) => /^metadata$/i.test(c.section || ""));
      if (m) meta = Object.fromEntries(m.text.split(/\.\s+(?=[a-z_]+:)/).map((p) => p.split(/:\s*/)).filter((kv) => kv.length >= 2).map(([k, ...v]) => [k.trim(), v.join(": ").replace(/\.$/, "").trim()]));
      cs = cs.filter((c) => !/^metadata$/i.test(c.section || ""));
    }
    cs.forEach((c) => { c.terms = terms(c.section + " " + (c.policy_id || "") + " " + c.text); c.lower = (c.section + " " + c.text).toLowerCase().replace(/\s+/g, " "); });
    this.chunks.push(...cs);
    this.docs.set(path, { path, namespace, version, updated_at, passages: cs.length, ...(meta ? { meta } : {}) });
    this._index();
    return { path, version, passages: cs.length };
  }

  _index() {
    this.df = new Map();
    for (const c of this.chunks) for (const t of new Set(c.terms)) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.avgLen = this.chunks.reduce((a, c) => a + c.terms.length, 0) / Math.max(1, this.chunks.length);
  }

  stats() { return { documents: this.docs.size, passages: this.chunks.length, namespaces: [...new Set(this.chunks.map((c) => c.namespace))] }; }

  search(query, { namespaces = null, limit = 5, includeSuperseded = false, includeTraining = true } = {}) {
    const q = [...new Set(terms(query))];
    if (!q.length) return [];
    const words = String(query).toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
    const phrases = words.slice(1).map((w, i) => words[i] + " " + w);
    const N = this.chunks.length, k1 = 1.4, b = 0.75;
    const scored = [];
    for (const c of this.chunks) {
      if (namespaces && namespaces.indexOf(c.namespace) < 0) continue;
      if (c.superseded && !includeSuperseded) continue;
      if (c.synthetic && !includeTraining) continue;
      let s = 0, matched = 0; const len = c.terms.length;
      for (const t of q) {
        let tf = 0; for (const x of c.terms) if (x === t) tf++;
        if (!tf) continue;
        matched++;
        const idf = Math.log(1 + (N - this.df.get(t) + 0.5) / (this.df.get(t) + 0.5));
        s += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * len / (this.avgLen || 1)));
      }
      /* Policies outrank commentary about them; training cases rank last. */
      /* A passage that shares one word with a long question is not an answer. */
      if (matched / q.length < 0.4 || (q.length >= 3 && matched < 2)) continue;
      if (s > 0 && c.policy_id) s *= 1.25;
      if (s > 0 && c.synthetic) s *= 0.7;
      if (s > 0 && c.namespace === "fabric") s *= 0.6;   /* House knowledge outranks the general reference */
      /* In the reference, the query's words side by side ("opportunity cost")
         outrank the same words scattered through a passage.  House documents
         keep their own ranking. */
      if (s > 0 && c.namespace === "fabric" && phrases.length && phrases.some((ph) => c.lower.indexOf(ph) >= 0)) s *= 1.6;
      if (s > 0) scored.push({ c, s });
    }
    scored.sort((a, b2) => b2.s - a.s);
    return scored.slice(0, limit).map(({ c, s }) => ({
      id: c.id, path: c.path, namespace: c.namespace, title: c.title, section: c.section, text: c.text, score: Math.round(s * 100) / 100,
      policy_id: c.policy_id, policy_status: c.policy_status, binding: c.policy_id ? c.policy_status === "ACTIVE" : null,
      synthetic: c.synthetic, version: c.version, updated_at: c.updated_at,
      citation: c.path + (c.section ? " § " + c.section : "") + (c.policy_id ? " (" + c.policy_id + (c.policy_status ? ", " + c.policy_status : "") + ")" : ""),
      reference: c.namespace === "fabric",
    }));
  }
}
