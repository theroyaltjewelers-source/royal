/* The executive attention engine.  Its job is to keep things away from Tahir
   as much as to bring things to him: an item with nothing for him to know,
   decide, approve, do, delegate or monitor never reaches his surface. */

import { PRIORITY_RANK, RISK_RANK, NEED, PRIORITY } from "./enums.js";

export function byAttention(a, b) {
  return (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])
    || (RISK_RANK[b.risk] - RISK_RANK[a.risk])
    || ((a.due_at || Infinity) - (b.due_at || Infinity))
    || ((b.amount || 0) - (a.amount || 0));
}

/* Collapse duplicates: the same fact reported by two specialists, or by the
   calculator and by ROYAL's own rule, appears once, at its most severe. */
export function dedupe(items) {
  const seen = new Map();
  for (const i of items) {
    const k = i.id;
    const cur = seen.get(k);
    if (!cur || byAttention(i, cur) < 0) seen.set(k, i);
  }
  return Array.from(seen.values());
}

export function executive(items) {
  return dedupe(items).filter((i) => i.need && i.need !== NEED.NONE).sort(byAttention);
}

/* Needs Tahir: something he must decide, approve or do himself, now or this
   week.  MONITOR and KNOW at P3 and below stay in the drill-down. */
export function needsTahir(items) {
  return executive(items).filter((i) =>
    [NEED.DECIDE, NEED.APPROVE, NEED.DO].indexOf(i.need) >= 0 && PRIORITY_RANK[i.priority] <= PRIORITY_RANK[PRIORITY.P2]);
}

/* Notification policy: P0 now; P1 now only if waiting for the next briefing
   changes the outcome; P2 at the next briefing; P3 and P4 never pushed. */
export function deliveryFor(item) {
  if (item.priority === PRIORITY.P0) return "IMMEDIATE";
  if (item.priority === PRIORITY.P1) return item.time_critical ? "IMMEDIATE" : "NEXT_BRIEFING";
  if (item.priority === PRIORITY.P2) return "NEXT_BRIEFING";
  return "ON_REQUEST";
}
