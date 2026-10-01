/* System congruence: does the House's data agree with itself?

   ROYAL reads the House through the calculator's snapshot.  Some facts in
   it are stated twice (the treasury's receivable and the projects' own
   balances; the payables total and the overdue bills), and some records
   point at others (a project at its client).  When two statements of one
   fact disagree, that is a SOURCE_CONFLICT: ROYAL reports it and does not
   silently pick one.  When a record points nowhere or two records look like
   one entity, that is a DATA_INTEGRITY issue.

   Deterministic arithmetic on the snapshot's own fields; nothing here
   recomputes price, margin, value or runway, which stay the calculator's. */

const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
const TOL = 1;   /* one dollar: rounding, not a conflict */

export function congruence(snapshot) {
  const issues = [];
  if (!snapshot) return { ok: true, issues };
  const live = (snapshot.projects || []).filter((p) => !p.archived && !p.deleted);
  const tr = snapshot.treasury || null;

  /* The same receivable, stated twice. */
  const owed = live.reduce((a, p) => a + Math.max(0, Number(p.outstanding) || 0), 0);
  if (tr && typeof tr.receivable === "number" && Math.abs(tr.receivable - owed) > TOL)
    issues.push({ kind: "SOURCE_CONFLICT", code: "RECEIVABLE_MISMATCH", fact: "money owed to us",
      a: { source: "calculator treasury", value: tr.receivable }, b: { source: "sum of project balances", value: owed },
      text: "The treasury says " + money(tr.receivable) + " is owed to us, but the project balances add up to " + money(owed) + "." });

  /* Payables: a total of zero beside an overdue bill cannot both be right. */
  const overdue = tr && tr.inbox ? tr.inbox.filter((i) => i.sec === "payables" && typeof i.amount === "number") : [];
  const overdueSum = overdue.reduce((a, i) => a + i.amount, 0);
  if (tr && typeof tr.payable === "number" && overdueSum > tr.payable + TOL)
    issues.push({ kind: "SOURCE_CONFLICT", code: "PAYABLE_MISMATCH", fact: "money we owe vendors",
      a: { source: "calculator treasury total", value: tr.payable }, b: { source: "overdue bills listed", value: overdueSum },
      text: "The treasury says we owe vendors " + money(tr.payable) + ", but it lists " + money(overdueSum) + " in overdue bills." });

  /* A project's balance should be its value less what was paid. */
  for (const p of live) {
    if ([p.value, p.paid, p.outstanding].some((x) => typeof x !== "number")) continue;
    if (Math.abs(p.value - p.paid - p.outstanding) > TOL)
      issues.push({ kind: "SOURCE_CONFLICT", code: "PROJECT_BALANCE_MISMATCH", fact: "balance on " + p.id, entity: p.id,
        text: (p.name || p.id) + " is valued at " + money(p.value) + " with " + money(p.paid) + " paid, but its balance reads " + money(p.outstanding) + "." });
  }

  /* Records that point nowhere, and two clients that look like one. */
  const clients = snapshot.clients || [];
  const ids = new Set(clients.map((c) => c.id));
  for (const p of live) if (p.client && p.client.id && clients.length && !ids.has(p.client.id))
    issues.push({ kind: "DATA_INTEGRITY", code: "MISSING_CLIENT", entity: p.id, text: (p.name || p.id) + " points to a client the calculator didn't send." });
  const byName = new Map();
  for (const c of clients) { const k = String(c.name || "").trim().toLowerCase(); if (!k) continue; byName.set(k, (byName.get(k) || []).concat(c.id)); }
  for (const [name, list] of byName) if (list.length > 1)
    issues.push({ kind: "DATA_INTEGRITY", code: "POSSIBLE_DUPLICATE_CLIENT", entity: list.join(","), text: list.length + " client records share the name " + name.replace(/\b\w/g, (m) => m.toUpperCase()) + "." });

  return { ok: !issues.length, issues };
}
