/* The agent activity ledger: what each specialist actually worked on.

   ROYAL should not have to ask its specialists what they did; it assigned
   the work, so it already knows.  Three records, read together:

     agent_day      a per-agent, per-day rollup of every native specialist
                    run (ACE, GRACE, LEDGER, FORGE inside ROYAL): how many
                    runs, for which kinds of request, how they ended, and
                    the most recent few with their outcome
     agent_tasks    work delegated to a Grok Bot (core/intelligence/agents.js):
                    objective, status history, result, cancel reason
     bot feed       what each Grok Bot posted to ROYAL today (core/grokbot/),
                    which is the bot's own report: REPORTED, never VERIFIED

   "Today" is one day for every part of ROYAL: the calendar day in the
   House's zone (America/New_York), whatever the server's own zone is.

   Writes use compare-and-swap with a bounded retry, so two requests
   finishing at once both count.  A failure to record never fails the
   request that did the work. */

export const AGENTS = [
  { id: "ace", name: "ACE", domain: "sales and the CRM" },
  { id: "grace", name: "GRACE", domain: "active clients and production" },
  { id: "ledger", name: "LEDGER", domain: "money" },
  { id: "house", name: "HOUSE", domain: "brand and marketing" },
  { id: "forge", name: "FORGE", domain: "systems and data" },
];

/* After a lost compare-and-swap: wait a little, randomly, so writers that
   collided do not collide again in lockstep. */
export const backoff = (attempt) => new Promise((r) => setTimeout(r, Math.random() * Math.min(50, 2 * attempt)));

export function dayOf(ts, tz = "America/New_York") {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
    return p.year + "-" + p.month + "-" + p.day;
  } catch (_) { return new Date(ts).toISOString().slice(0, 10); }
}

/* What a run of a request kind means, in Tahir's words. */
const OBJECTIVE = {
  what_needs_me: "triage", state_of_house: "the House overview", who_owes_us: "receivables", waiting_for: "what we're waiting on", commitments: "commitments",
  production_status: "production", project_status: "a project", project_money: "a project's money", revenue_leakage: "revenue leakage", clients_at_risk: "client risk",
  sales_pipeline: "the pipeline", morning_briefing: "the briefing", can_i_step_away: "whether you can step away", what_changed: "what changed",
  handle_it: "handling the open items", home_status: "the home screen", system_status: "system health", greeting: "the greeting", open_question: "an open question",
};
export const objectiveWords = (skill) => OBJECTIVE[skill] || String(skill || "a request").replace(/_/g, " ");

export class AgentActivityLedger {
  constructor({ store, clock = () => Date.now(), tz = "America/New_York" }) { Object.assign(this, { store, clock, tz }); }

  /* One native specialist run.  status: OK | PARTIAL | FAILED | NOT_CONNECTED;
     reason (when not OK): TIMEOUT | ERROR | INVALID_RESULT | NOT_CONNECTED. */
  async noteRun({ agent, skill, status, reason = null, findings = 0, run_id = null, ms = null, error = null }) {
    const at = this.clock(), day = dayOf(at, this.tz), id = agent + ":" + day;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (attempt) await backoff(attempt);
      const cur = await this.store.get("agent_day", id);
      const d = cur ? { ...cur.data } : { agent, day, runs: 0, ok: 0, failed: 0, timed_out: 0, not_connected: 0, findings: 0, objectives: {}, first_at: at, recent: [] };
      d.runs++; d.last_at = at; d.findings += findings || 0;
      if (status === "OK" || status === "PARTIAL") d.ok++;
      else if (reason === "TIMEOUT") d.timed_out++;
      else if (status === "NOT_CONNECTED") d.not_connected++;
      else d.failed++;
      d.objectives = { ...d.objectives, [skill]: (d.objectives[skill] || 0) + 1 };
      d.recent = [{ at, skill, status, reason, findings, run_id, ms, error: error ? String(error).slice(0, 160) : null }].concat(d.recent || []).slice(0, 12);
      const w = await this.store.put("agent_day", id, d, cur ? cur.rev : null);
      if (w.ok) return d;
    }
    return null;
  }

  async day(agent, day) { const r = await this.store.get("agent_day", agent + ":" + day); return r ? r.data : null; }

  /* Everything known about each agent for one day, from ROYAL's own records
     and, for Grok Bots, their feeds.  Each agent is read on its own: one
     that cannot be read is reported as such and the others still are. */
  async review({ day = dayOf(this.clock(), this.tz), agents = AGENTS.map((a) => a.id), tasks = null, bridge = null, realm = "BUSINESS" } = {}) {
    let allTasks = [];
    if (tasks) { try { allTasks = await tasks.list(); } catch (_) { allTasks = null; } }
    let bots = null;
    if (bridge) { try { const l = await bridge.listBots({ realm }); bots = l.body && l.body.bots ? l.body.bots : null; } catch (_) { bots = null; } }
    const out = await Promise.allSettled(agents.map(async (id) => {
      const meta = AGENTS.find((a) => a.id === id) || { id, name: id.toUpperCase(), domain: "" };
      const native = await this.day(id, day);
      const delegated = allTasks === null ? null : allTasks.filter((t) => t.agent === id && dayOf(t.created_at, this.tz) === day);
      const bot = bots ? bots.find((b) => b.id === id) || null : null;
      let feed = null;
      if (bridge && bot) {
        try {
          const f = await bridge.getFeed(id, { realm, limit: 100 });
          feed = ((f.body && f.body.events) || []).filter((e) => e.type !== "outbound" && dayOf(Date.parse(e.created_at), this.tz) === day);
        } catch (e) { feed = { error: String(e.message || e) }; }
      }
      return { ...meta, native, delegated, bot: bot ? { connection: bot.connection || bot.status, last_seen: bot.last_seen, last_error: bot.last_error } : null, feed };
    }));
    return { day, agents: out.map((r, i) => (r.status === "fulfilled" ? r.value : { ...AGENTS.find((a) => a.id === agents[i]), error: String(r.reason && r.reason.message || r.reason) })) };
  }
}
