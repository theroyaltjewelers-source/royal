/* What changed: last verified state against current verified state.  Both
   sides are calculator snapshots, so every change reported here is a change
   in verified business state, not in ROYAL's opinion of it. */

import { money } from "../../../core/util.js";

const RANK = { ok: 0, wait: 1, risk: 2 };

export function diffSnapshots(before, after) {
  if (!before || !after) return { baseline_at: before ? before.generated_at : null, current_at: after ? after.generated_at : null, changes: [], comparable: false };
  const b = new Map(before.projects.map((p) => [p.id, p])), changes = [];
  const name = (p) => ((p.client && p.client.name) || "Unnamed client") + ", " + (p.name || "untitled");
  const push = (kind, p, text, tone, extra = {}) => changes.push({ kind, project_id: p ? p.id : null, text, tone, ...extra });

  for (const p of after.projects) {
    const o = b.get(p.id);
    if (!o) { push("PROJECT_CREATED", p, "New commission: " + name(p) + " at " + p.stage + ".", "info"); continue; }
    b.delete(p.id);
    if (p.paid > o.paid + 0.005) push("PAYMENT_RECEIVED", p, money(p.paid - o.paid) + " recorded from " + name(p) + ".", "gain", { amount: p.paid - o.paid });
    if (p.paid < o.paid - 0.005) push("PAYMENT_VOIDED", p, money(o.paid - p.paid) + " no longer counts on " + name(p) + " (voided or corrected).", "loss", { amount: o.paid - p.paid });
    if (p.stage !== o.stage) push("STAGE_CHANGED", p, name(p) + " moved from " + o.stage + " to " + p.stage + ".", p.stage === "Delivered" || p.stage === "Ready" ? "gain" : "info", { from: o.stage, to: p.stage });
    if ((p.due || null) !== (o.due || null)) push("DEADLINE_CHANGED", p, name(p) + " target date " + (o.due ? "moved from " + o.due + " to " + (p.due || "none") : "set to " + p.due) + ".", "info");
    if (Math.abs(p.value - o.value) > 0.5) push("VALUE_CHANGED", p, name(p) + " value changed from " + money(o.value) + " to " + money(p.value) + ".", "info");
    const hb = o.health && o.health.s, ha = p.health && p.health.s;
    if (hb && ha && hb !== ha) push(RANK[ha] > RANK[hb] ? "RISK_INCREASED" : "RISK_RESOLVED", p,
      name(p) + (RANK[ha] > RANK[hb] ? " now needs attention: " : " is back on track: ") + (p.health.t || ha) + ".", RANK[ha] > RANK[hb] ? "alert" : "gain");
  }
  for (const o of b.values()) push("PROJECT_REMOVED", o, name(o) + " is no longer in the live records.", "info");

  const ib = new Map(((before.treasury && before.treasury.inbox) || []).map((i) => [i.key, i]));
  for (const i of (after.treasury && after.treasury.inbox) || []) {
    if (!ib.has(i.key)) changes.push({ kind: "TREASURY_NEW", text: i.title + ". " + i.desc, tone: i.sev === "critical" ? "alert" : "info" });
    ib.delete(i.key);
  }
  for (const i of ib.values()) changes.push({ kind: "TREASURY_RESOLVED", text: "Resolved: " + i.title + ".", tone: "gain" });

  const order = { alert: 0, gain: 1, loss: 1, info: 2 };
  changes.sort((x, y) => order[x.tone] - order[y.tone]);
  return { baseline_at: before.generated_at, current_at: after.generated_at, changes, comparable: true };
}
