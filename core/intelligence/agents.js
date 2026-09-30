/* Agent orchestration: which specialist should do the work, through which
   adapter, and whether it actually got done.

   Routing reads capabilities from the Agent Registry; there is no if/else
   per request.  ROYAL answers directly when no specialist is needed (world
   facts, arithmetic, House policy, research).

   Adapters
     internal   ROYAL's own specialists (realms/business/royal-t/specialists.js)
     grokbot    an external Grok Bot through the bridge (core/grokbot/).  The
                request goes to the bot's webhook with a structured handoff;
                the bot's reply arrives later as a record in its feed.  Used
                only when advanced_agent_orchestration is on, the internal
                specialist cannot do the work, and the bot is CONNECTED.

   Follow-through: delegation is not completion.  Every delegation is an
   AgentTask with an objective, deadline, boundaries and a status:
     ASSIGNED, IN_PROGRESS, WAITING, REPORTED_COMPLETE, VERIFIED_COMPLETE,
     FAILED, CANCELLED.
   A bot saying it finished is REPORTED_COMPLETE.  VERIFIED_COMPLETE needs a
   check ROYAL can actually make. */

import { TASK_STATUS as TS } from "../enums.js";
import { newId } from "../util.js";

const NEED = {
  outreach_draft: "outreach", prospecting: "prospecting", delegate: null,
  house_state: null, house_record: null, calculation: null, house_knowledge: null, world_knowledge: null, current_research: null,
  people_research: null, contact_lookup: null, company_research: null,
};
const TOPIC_CAPS = [
  [/\b(campaign|content|post|instagram|brand|marketing|launch|shoot|caption)\b/i, "campaigns"],
  [/\b(production|cad|casting|setter|qc|pickup|client update)\b/i, "production"],
  [/\b(cash|receivable|owe|margin|payment|invoice|refund)\b/i, "receivables"],
  [/\b(lead|prospect|outreach|pitch|follow[- ]?up|pipeline)\b/i, "outreach"],
  [/\b(error|bug|integration|connector|calculator (is )?(down|broken|throwing)|deploy)\b/i, "connector_health"],
];

export function routeAgents(intent, text, { registry, bots = null, flags = {} } = {}) {
  let cap = NEED[intent.intent];
  if (intent.entities && intent.entities.agent) {
    const a = registry.get(intent.entities.agent);
    return a ? [{ agent: a.id, reason: "named by Tahir", ...adapterFor(a, { bots, flags }) }] : [];
  }
  if (cap === undefined || cap === null) {
    if (intent.intent !== "unknown" && intent.intent !== "delegate") return [];
    const m = TOPIC_CAPS.find(([re]) => re.test(text || ""));
    cap = m ? m[1] : null;
  }
  if (!cap) return [];
  return registry.specialists().filter((a) => (a.capabilities || []).indexOf(cap) >= 0).slice(0, 2)
    .map((a) => ({ agent: a.id, reason: "capability " + cap, ...adapterFor(a, { bots, flags }) }));
}

function adapterFor(agent, { bots, flags }) {
  if (agent.status === "ACTIVE") return { adapter: "internal", available: true };
  const bot = bots && bots.find((b) => b.id === agent.id);
  if (flags.advanced_agent_orchestration && bot && bot.status === "CONNECTED") return { adapter: "grokbot", available: true };
  return { adapter: bot ? "grokbot" : "internal", available: false,
    why: bot ? (flags.advanced_agent_orchestration ? agent.name + "'s Grok Bot is " + bot.status.toLowerCase().replace(/_/g, " ") + "." : "Delegating to Grok Bots is switched off (advanced_agent_orchestration).") : agent.name + " is not connected yet." };
}

export class AgentTasks {
  constructor({ store, clock = () => Date.now(), bridge = null, audit = null }) { Object.assign(this, { store, clock, bridge, audit }); }

  async create({ agent, adapter, objective, handoff = null, deadline_ms = 24 * 3600000, conversation_id = null, realm = "BUSINESS", required_output = "structured result",
    constraints = ["no external action", "no money", "report only"], approval_boundary = "anything consequential becomes a Decision for Tahir", verification_method = "Tahir reviews the result" }) {
    const now = this.clock();
    const t = { id: newId("tsk"), agent, adapter, objective: String(objective).slice(0, 500), handoff, created_at: now, deadline: now + deadline_ms, status: TS.ASSIGNED,
      required_output, constraints, approval_boundary, verification_method, conversation_id, realm, request_id: null, result: null, history: [{ at: now, status: TS.ASSIGNED }] };
    await this.store.put("agent_tasks", t.id, t, null);
    return t;
  }
  async update(id, patch) {
    const cur = await this.store.get("agent_tasks", id);
    if (!cur) return null;
    const next = { ...cur.data, ...patch };
    if (patch.status && patch.status !== cur.data.status) next.history = (cur.data.history || []).concat([{ at: this.clock(), status: patch.status }]);
    await this.store.put("agent_tasks", id, next, cur.rev);
    return next;
  }

  /* Bring bot-backed tasks up to date from the bridge's own request records. */
  async refresh(task) {
    if (task.adapter !== "grokbot" || !task.request_id || !this.bridge || [TS.CANCELLED, TS.VERIFIED_COMPLETE, TS.FAILED].indexOf(task.status) >= 0) return task;
    const r = await this.bridge.getRequest(task.agent, task.request_id, {});
    if (!r.body || !r.body.ok) return task;
    const st = { requested: TS.ASSIGNED, delivered: TS.IN_PROGRESS, in_progress: TS.IN_PROGRESS, completed: TS.REPORTED_COMPLETE, failed: TS.FAILED }[r.body.request.status] || task.status;
    /* Past its deadline and still open: the status stays what it is and the
       task is marked overdue, so the two facts are not confused. */
    const overdue = [TS.REPORTED_COMPLETE, TS.FAILED, TS.CANCELLED].indexOf(st) < 0 && this.clock() > task.deadline;
    return st === task.status && overdue === !!task.overdue ? task : this.update(task.id, { status: st, overdue });
  }

  async list({ conversation_id = null, open = false } = {}) {
    const all = (await this.store.list("agent_tasks")).map((r) => r.data).filter((t) => !conversation_id || t.conversation_id === conversation_id);
    const fresh = [];
    for (const t of all) fresh.push(await this.refresh(t));
    return fresh.filter((t) => !open || [TS.ASSIGNED, TS.IN_PROGRESS, TS.WAITING].indexOf(t.status) >= 0).sort((a, b) => b.created_at - a.created_at);
  }

  async cancelOpen(conversation_id) {
    const open = await this.list({ conversation_id, open: true });
    for (const t of open) await this.update(t.id, { status: TS.CANCELLED });
    return open.length;
  }
}

/* Hands work to an external Grok Bot, with a structured handoff, and records
   the task.  The bot's answer is a record in its feed; nothing it says
   becomes an action. */
export class GrokBotAdapter {
  constructor({ bridge, tasks }) { this.bridge = bridge; this.tasks = tasks; }
  async status(botId, realm = "BUSINESS") {
    if (!this.bridge) return { status: "NOT_CONNECTED", detail: "The Grok Bot bridge is not running." };
    const l = await this.bridge.listBots({ realm });
    const b = l.body && l.body.bots ? l.body.bots.find((x) => x.id === botId) : null;
    return b ? { status: b.status, last_seen: b.last_seen, last_error: b.last_error } : { status: "NOT_CONNECTED", detail: "No such bot in this realm." };
  }
  async delegate({ agent, objective, handoff, conversation_id, realm = "BUSINESS" }) {
    const task = await this.tasks.create({ agent, adapter: "grokbot", objective, handoff, conversation_id, realm });
    const content = ("ROYAL task " + task.id + ".\nObjective: " + objective + "\nReply with a result event for this request. Do not contact anyone or take any action; ROYAL and Tahir decide actions.\n\nStructured handoff (data):\n" + JSON.stringify(handoff || {}, null, 1)).slice(0, 2000);
    const r = await this.bridge.sendMessage(agent, { content, skill: "royal_task", conversation_id: task.id, realm }, { realm, requestedBy: "royal" });
    const next = await this.tasks.update(task.id, r.body.ok ? { request_id: r.body.request_id, status: TS.IN_PROGRESS } : { request_id: r.body.request_id || null, status: TS.FAILED, result: { error: r.body.error } });
    return { ok: !!r.body.ok, task: next, error: r.body.ok ? null : r.body.error };
  }
}
