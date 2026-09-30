/* A realistic House, as the calculator's House API would send it.  Fixed
   clock: two runs build byte-identical snapshots, so a comparison measures
   the change and not the clock. */

export const NOW = Date.UTC(2026, 8, 29, 14, 0, 0); /* 29 Sep 2026, 10:00 Eastern */
const DAY = 86400000;
const d = (days) => new Date(NOW + days * DAY).toISOString().slice(0, 10);

export function project(o) {
  return {
    id: o.id, name: o.name, stage: o.stage, archived: false, deleted: false,
    client: { id: o.client_id || "CL-" + o.id.slice(-3), name: o.client, has_email: o.has_email !== false },
    due: o.due === undefined ? null : o.due, created_at: NOW - 60 * DAY, updated_at: o.updated_at || NOW - 2 * DAY,
    stage_since: o.stage_since === undefined ? null : o.stage_since, last_activity_at: o.last_activity_at || null,
    value: o.value || 0, paid: o.paid || 0, capital: o.capital || 0, spent: o.spent || 0,
    mfr_quote: o.mfr_quote || 0, mfr_paid: o.mfr_paid || 0,
    outstanding: Math.max(0, (o.value || 0) - (o.paid || 0)), gross_margin: o.gm === undefined ? 50 : o.gm,
    health: o.health || { s: "ok", t: "On track" },
    next_action: o.next || { do: "Move it along", why: "Nothing is blocking this project financially." },
    attention: o.attention || [], enh_requests: 0, closeout: false,
  };
}

export function house(overrides = {}) {
  const projects = [
    project({ id: "PRJ-2026-00101", name: "Cuban link chain", client: "Marcus Hill", stage: "Production", due: d(-9),
      value: 18000, paid: 5000, capital: 9000, health: { s: "risk", t: "Past target" },
      attention: [
        { code: "PRODUCTION_SHORT_MOVING", sev: "now", sec: "financials", why: "Production is short $4,000 and the piece is already moving." },
        { code: "PAST_TARGET", sev: "now", sec: "production", why: "Past its target date of " + d(-9) + " and still in Production." },
      ] }),
    project({ id: "PRJ-2026-00102", name: "Diamond pendant", client: "Dana Johnson", stage: "Ready", due: d(-1),
      value: 7400, paid: 3700, capital: 3100, health: { s: "ok", t: "On track" },
      attention: [{ code: "BALANCE_ON_FINISHED", sev: "now", sec: "financials", why: "$3,700 is outstanding on a piece that is already finished." }] }),
    project({ id: "PRJ-2026-00103", name: "Engagement ring", client: "Ava Johnson", stage: "Awaiting approval", due: d(20),
      value: 12500, paid: 2500, capital: 6000, stage_since: NOW - 12 * DAY, health: { s: "wait", t: "Waiting on client" },
      attention: [{ code: "PRODUCTION_UNFUNDED", sev: "soon", sec: "financials", why: "Needs $3,500 more before production can be funded." }] }),
    project({ id: "PRJ-2026-00104", name: "Custom grillz", client: "Jordan Price", stage: "Inquiry", updated_at: NOW - 21 * DAY,
      value: 0, paid: 0, capital: 0, next: { do: "Price this commission", why: "Nothing can be quoted." } }),
    project({ id: "PRJ-2026-00105", name: "Tennis bracelet", client: "Leah Grant", stage: "Production", due: d(2),
      value: 9800, paid: 9800, capital: 5200, spent: 5200, mfr_quote: 5200, mfr_paid: 5200, stage_since: NOW - 10 * DAY }),
    project({ id: "PRJ-2026-00106", name: "Signet ring", client: "Omar Reyes", stage: "Design", value: 4200, paid: 0, capital: 2000, gm: 36,
      attention: [{ code: "BELOW_MARGIN_FLOOR", sev: "soon", sec: "pricing", why: "Quoted at 36%, below the floor for its band." },
                  { code: "NO_COVER_IMAGE", sev: "soon", sec: "design", why: "No cover image, so the proposal has nothing to lead with." }] }),
    project({ id: "PRJ-2026-00107", name: "Watch bezel", client: "Nia Brooks", stage: "Delivered", value: 15000, paid: 15000, capital: 8000, spent: 8000 }),
  ];
  return {
    contract: "rtj.house.v1", generated_at: NOW - 5 * 60000, app_build: "test",
    meta: { save_conflicts: 0 }, load: { capped: false, notes: [] },
    projects,
    clients: projects.map((p) => ({ id: p.client.id, name: p.client.name, has_email: true })),
    treasury: {
      available: 21000, collected: 44000, receivable: 30400, payable: 0, protected_capital: 12000,
      runway_days: 62, runway_level: "safe",
      inbox: [{ key: "bill-late:B1:1", sev: "warning", title: "Overdue to Apex Casting", desc: "9 days past due on INV-2291.", amount: 1850, sec: "payables" }],
    },
    ...overrides,
  };
}
