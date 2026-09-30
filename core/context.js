/* Context resolution: turning "that pendant", "his project" or "the Johnson
   ring" into one canonical record, or admitting that it cannot.

   Sources, strongest first: the entity selected in the interface, an explicit
   ID in the text, names in the text, then what this conversation was last
   about.  Names are never identifiers; two clients can share one. */

const PRONOUN = /\b(it|this|that|he|him|his|she|her|they|them|their|the same|the client)\b(\s+(one|project|piece|ring|pendant|chain|order|commission|client))?/i;
const ID = /\bPRJ-\d{4}-\d{5}\b/i;
const STOP = new Set(["the", "and", "for", "with", "what", "why", "who", "how", "status", "project",
  "piece", "order", "client", "hasnt", "hasn", "moved", "doing", "update", "about", "tell", "show", "house", "royal", "today", "money",
  "owes", "owe", "need", "needs", "production", "waiting", "tahir", "custom", "does", "did", "last", "talk", "when", "pull", "open",
  "bring", "focus", "have", "prepare", "draft", "send", "holding", "much", "balance", "paid", "still", "grace", "ace", "ledger", "forge"]);

/* Surnames that are also everyday words.  Written in lower case inside
   otherwise capitalised text, they are read as words, not as clients. */
const COMMON_WORDS = new Set(["price", "rich", "young", "king", "white", "black", "brown", "green", "gray", "grey", "grant", "rose", "may", "bell", "wood", "stone",
  "gold", "silver", "love", "long", "short", "little", "day", "north", "south", "west", "east", "hunt", "lane", "page", "park", "ward", "cook", "cash", "hall",
  "hill", "banks", "baker", "carter", "cross", "dean", "fox", "frank", "free", "glass", "golden", "hope", "joy", "lamb", "major", "marsh", "mason", "miller", "moss",
  "noble", "rice", "rivers", "rock", "sage", "sharp", "small", "snow", "spring", "street", "summer", "swift", "walker", "waters", "wells", "wise", "woods", "brooks"]);

function words(s) { return String(s || "").toLowerCase().replace(/['’]s\b/g, "").replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean); }

export function resolveEntity(text, { projects = [], selected = null, recent = null } = {}) {
  if (selected && selected.type === "project" && projects.some((p) => p.id === selected.id))
    return { status: "RESOLVED", via: "selected", strong: true, entity: projects.find((p) => p.id === selected.id) };

  const idm = ID.exec(text || "");
  if (idm) {
    const p = projects.find((x) => x.id.toUpperCase() === idm[0].toUpperCase());
    return p ? { status: "RESOLVED", via: "id", strong: true, entity: p } : { status: "NOT_FOUND", via: "id", query: idm[0] };
  }

  const w = words(text).filter((x) => x.length >= 3 && !STOP.has(x));
  /* A surname that is also an everyday word is read as the word only when it
     is used as one: after an article or qualifier ("the spot price of
     gold", "a gold price"), or followed by "of".  Otherwise, and whenever it
     is capitalised, it is the client's name ("Did brooks pay?"). */
  const raw = String(text || "");
  const wordSense = (t) => new RegExp("\\b(the|a|an|this|that|its|their|our|your|spot|gold|silver|stock|share|market|current|today'?s|best|lowest|highest)\\s+" + t + "\\b", "i").test(raw)
    || new RegExp("\\b" + t + "\\s+(of|per)\\b", "i").test(raw);
  const writtenAsName = (t) => !COMMON_WORDS.has(t) || new RegExp("\\b" + t.charAt(0).toUpperCase() + t.slice(1) + "\\b").test(raw) || !wordSense(t);
  if (w.length) {
    const scored = projects.map((p) => {
      const c = words(p.client && p.client.name), n = words(p.name);
      let s = 0, byClient = false;
      for (const t of w) { if (c.indexOf(t) >= 0) { s += 3; if (writtenAsName(t)) byClient = true; } if (n.indexOf(t) >= 0) s += 2; }
      return { p, s, byClient };
    }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    if (scored.length) {
      const top = scored[0].s, tied = scored.filter((x) => x.s === top);
      /* A match on the piece alone ("grillz") is weak: it is enough when the
         question is plainly about a record, not enough to hijack a general
         question that happens to mention a product. */
      if (tied.length === 1) return { status: "RESOLVED", via: "name", entity: tied[0].p, strong: tied[0].byClient };
      return { status: "AMBIGUOUS", via: "name", candidates: tied.slice(0, 6).map((x) => x.p) };
    }
  }

  if (recent && PRONOUN.test(text || "")) {
    const p = projects.find((x) => x.id === recent.id);
    if (p) return { status: "RESOLVED", via: "conversation", strong: true, entity: p };
  }
  return { status: "NONE" };
}

/* Short-lived conversation memory (memory layer 1).  Holds what a
   conversation is about for a few hours and nothing else; it is never a
   source of business facts. */
export class ConversationContext {
  constructor(ttlMs = 6 * 3600000, clock = () => Date.now()) { this.m = new Map(); this.ttl = ttlMs; this.clock = clock; }
  get(id) {
    const r = this.m.get(id);
    if (!r || this.clock() - r.at > this.ttl) { this.m.delete(id); return { entity: null, last_skill: null, last_items: [] }; }
    return r.v;
  }
  set(id, patch) { const v = { ...this.get(id), ...patch }; this.m.set(id, { at: this.clock(), v }); return v; }
}
