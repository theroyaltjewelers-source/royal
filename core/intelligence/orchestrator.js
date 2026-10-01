/* The agent orchestrator: how ROYAL works with ACE, GRACE, LEDGER, HOUSE
   and FORGE from the main conversation.

   One specialist, more than one way to run it.  ACE is one agent whether
   ROYAL's own sales logic answers (the native backend, over the House's
   data, in milliseconds) or ACE's Grok Bot does the work (the grokbot
   backend: a webhook out, a structured reply back).  Tahir sees ACE.

     AgentRouter (routeAgents, the House skills, the explicit name Tahir
     said) decides WHO.  The execution router below (chooseBackend) decides
     HOW.  delegateToAgent() is the one call that does the work; nothing
     else in ROYAL needs to know the bridge's routes.

   A Grok Bot's reply comes back through the bridge's event listener,
   matched to its handoff by request_id and handoff_id, recorded on the
   AgentTask and in the ledger, and returned to the conversation that
   asked: to the waiting request if it is still open, otherwise to that
   conversation's inbox, which the page reads.  The bot's feed keeps a copy;
   it is a record, not the channel.

   Bounded: at most MAX_HOPS hand-offs deep, never back to an agent already
   in the chain.  A bot's result is data: it can name a specialist it needs
   (ROYAL decides), propose actions (Tahir approves them through ROYAL), and
   report what it did (REPORTED_COMPLETE, never verified by its say-so). */

import { randomBytes } from "node:crypto";
import { replyInstructions } from "../grokbot/envelope.js";
import { TASK_STATUS as TS, CANCEL_REASON } from "../enums.js";

export const SPECIALIST_IDS = ["ace", "grace", "ledger", "house", "forge"];
export const MAX_HOPS = 3;
export const BACKEND = Object.freeze({ NATIVE: "native", GROKBOT: "grokbot" });
export const ROUTE = Object.freeze({ EXPLICIT_BOT_REQUEST: "EXPLICIT_BOT_REQUEST", SPECIALIST_CAPABILITY_ROUTE: "SPECIALIST_CAPABILITY_ROUTE",
  NATIVE_FAST_PATH: "NATIVE_FAST_PATH", DURABLE_BOT_ROUTE: "DURABLE_BOT_ROUTE", FALLBACK: "FALLBACK" });
export const DOMAIN_WORD = { ace: "sales", grace: "production", ledger: "finance", house: "brand", forge: "systems" };
const NAME = (id) => String(id).toUpperCase();
const rand = (n = 6) => randomBytes(n).toString("hex");

/* Work that benefits from a bot's own browser, computer or long-running
   workspace, rather than a read of the House's data. */
const DURABLE_WORK = /\b(research|find (me )?(companies|prospects|leads|contacts)|prospect(ing)?|browse|website|web ?site|crm|linkedin|instagram|post (it|this)|scrape|monitor|watch (for|the)|long[- ]running|over the next|campaign)\b/i;

/* ----------------------------------------------- explicit requests --- */
const AG = "(ace|grace|ledger|house|forge)";
const SINGLE = new RegExp("^\\s*(?:please\\s+|royal,?\\s+)?(?:ask|talk to|speak (?:to|with)|send (?:this|that|it) to|have|get|let|tell|check with|run (?:this|that|it) (?:by|past)|see what|loop in)\\s+" + AG + "\\b(?:'s)?", "i");
const OPINION = new RegExp("\\bget\\s+" + AG + "'s\\s+(opinion|view|take|read|thoughts)\\b", "i");
const MULTI = new RegExp("\\b(?:ask|have|get|let|tell|talk to|check with)\\s+(" + AG + "(?:\\s*(?:,|and|&)\\s*" + AG + ")+)\\b", "i");
const EACH = /\b(talk to|ask|check (in )?with|contact|reach( out to)?|ping|hear from)\s+(each|all|every(one)?|the)\s*(of\s+)?(the\s+|my\s+)?(bots?|agents?|specialists?|team)\b/i;
/* A client message stays with the drafting skill (delegate_draft). */
const DRAFT_ACTION = /\b(prepare|draft|write|put together|reach out|follow[\s-]?up with|nudge|remind|reminder|send|text|email|message)\b/i;

/* Which specialists Tahir asked for, by name, or "each of the bots".
   Returns null when he asked for none. */
export function parseAgentRequest(text) {
  const t = String(text || "").trim();
  if (EACH.test(t)) return { agents: SPECIALIST_IDS.slice(), each: true, explicit: true, objective: t };
  const m = MULTI.exec(t);
  if (m) {
    const ids = [...new Set((m[1].match(new RegExp(AG, "ig")) || []).map((x) => x.toLowerCase()))];
    return { agents: ids, each: false, explicit: true, objective: t };
  }
  const s = SINGLE.exec(t) || OPINION.exec(t);
  if (!s) return null;
  const id = (s[1] || "").toLowerCase();
  /* "house" is also a word ("have house prices risen?"); the specialist is written HOUSE. */
  if (id === "house" && s[1] !== "HOUSE") return null;
  /* "Have GRACE prepare an update for Marcus" is a client message: the
     drafting skill writes it, and sending still needs approval. */
  if (DRAFT_ACTION.test(t.slice(s.index + s[0].length)) && !/\b(look|tell|explain|why|what|how|opinion|view|think)\b/i.test(t.slice(s.index + s[0].length, s.index + s[0].length + 40))) return null;
  return { agents: [id], each: false, explicit: true, objective: t };
}

/* "the second thing", "the first one", "the last point". */
export function ordinalRef(text) {
  const m = /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last)\s+(thing|one|item|point|issue|part)\b/i.exec(String(text || ""));
  if (!m) return null;
  const w = m[1].toLowerCase();
  return w === "last" ? -1 : { first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3, fifth: 4, "5th": 4 }[w];
}

/* ------------------------------------------------ execution router --- */
const UNUSABLE = ["NOT_CONFIGURED", "DISABLED", "AUTH_FAILED", "FAILED"];

/* HOW a chosen specialist runs.  Explicit requests go to the real bot when
   it can be reached; work that needs a bot's own environment goes to a
   verified bot; everything else runs natively, fast.  Never a silent
   substitution: the provenance and the reason travel with the result. */
export function chooseBackend({ agent, backends, explicit = false, preferred = "auto", objective = "" }) {
  const nat = backends.native && backends.native.available, bot = backends.grokbot || {};
  const botUsable = !!bot.can_send && UNUSABLE.indexOf(bot.connection) < 0;
  const botWhy = !bot.configured ? "no Grok Bot is set up for " + NAME(agent) : !botUsable ? NAME(agent) + "'s Grok Bot is " + String(bot.connection || "not reachable").toLowerCase().replace(/_/g, " ") : null;
  const N = (provenance, why = null) => ({ backend: BACKEND.NATIVE, provenance, why });
  const B = (provenance, why = null) => ({ backend: BACKEND.GROKBOT, provenance, why });
  if (preferred === BACKEND.NATIVE) return nat ? N(ROUTE.NATIVE_FAST_PATH) : botUsable ? B(ROUTE.FALLBACK, NAME(agent) + " has no native runtime") : { backend: null, why: NAME(agent) + " has no native runtime" + (botWhy ? ", and " + botWhy : "") };
  if (preferred === BACKEND.GROKBOT) return botUsable ? B(explicit ? ROUTE.EXPLICIT_BOT_REQUEST : ROUTE.DURABLE_BOT_ROUTE) : nat ? N(ROUTE.FALLBACK, botWhy) : { backend: null, why: botWhy };
  if (explicit && botUsable) return B(ROUTE.EXPLICIT_BOT_REQUEST);
  if (DURABLE_WORK.test(objective) && bot.can_receive_tasks) return B(ROUTE.DURABLE_BOT_ROUTE);
  if (nat) return N(explicit ? ROUTE.FALLBACK : ROUTE.NATIVE_FAST_PATH, explicit && bot.configured ? botWhy : null);
  if (botUsable) return B(ROUTE.FALLBACK, NAME(agent) + " has no native runtime");
  return { backend: null, why: NAME(agent) + " has no native runtime" + (botWhy ? ", and " + botWhy : "") };
}

/* ------------------------------------------------- context, scoped --- */
/* What each specialist is given about the record under discussion: only
   what its work needs.  HOUSE gets the piece, never balances or contact
   details; LEDGER gets the money; FORGE gets ROYAL's own system state. */
export function contextFor(agentId, { project = null, item = null, points = null, system = null, previous = null } = {}) {
  const c = {};
  if (project) {
    const base = { project_id: project.id, piece: project.name, stage: project.stage, target_date: project.due || null };
    const client = project.client && project.client.name ? { client_name: project.client.name, client_id: project.client.id || null } : {};
    if (agentId === "house") c.project = base;
    else if (agentId === "ledger") c.project = { ...base, ...client, value: project.value, paid: project.paid, outstanding: project.outstanding, production_cost: project.capital == null ? null : project.capital };
    else if (agentId === "grace") c.project = { ...base, ...client, next_step: project.next_action ? project.next_action.do : null, health: project.health ? project.health.t : null, waiting: project.waiting || null };
    else if (agentId === "ace") c.project = { ...base, ...client, outstanding: project.outstanding, next_step: project.next_action ? project.next_action.do : null };
    else c.project = base;
  }
  if (item) c.referenced = item;
  if (points && points.length) c.previous_points = points.slice(0, 8);
  if (previous) c.previous_answer = String(previous).slice(0, 800);
  if (agentId === "forge" && system) c.system = system;
  return c;
}

/* ------------------------------------------------------ orchestrator --- */
export class AgentOrchestrator {
  constructor({ registry, bridge = null, tasks, ledger = null, audit = null, store, gate = null, clock = () => Date.now(), native = null, onLate = null,
    waitMs = 12000, maxHops = MAX_HOPS, logger = console }) {
    Object.assign(this, { registry, bridge, tasks, ledger, audit, store, gate, clock, native, onLate, waitMs, maxHops, logger });
    /* task id -> { outcome, resolve } while the request that sent it is
       still open.  A reply can arrive during the webhook call itself, before
       the sender is waiting; the slot holds it until then. */
    this.slots = new Map();
    if (bridge && bridge.onEvent) bridge.onEvent((e) => this.onBotEvent(e));
  }

  /* Each backend's real state for one agent. */
  async backends(agentId, realm = "BUSINESS") {
    const a = this.registry.get(agentId);
    const native = { available: !!(a && a.status === "ACTIVE" && this.native), why: a && a.status !== "ACTIVE" ? NAME(agentId) + " has no native runtime" : null };
    let grokbot = { configured: false, connection: "NOT_CONFIGURED", can_send: false, can_receive_tasks: false };
    if (this.bridge) {
      try {
        const l = await this.bridge.listBots({ realm });
        const b = l.body && l.body.bots ? l.body.bots.find((x) => x.id === agentId) : null;
        if (b) grokbot = { configured: b.config_state !== "NOT_CONFIGURED", connection: b.connection_state, can_send: b.can_send, can_receive_tasks: b.can_receive_tasks,
          last_verified_at: b.last_verified_at, last_roundtrip_ms: b.last_roundtrip_ms, last_error: b.last_error };
      } catch (e) { grokbot = { ...grokbot, connection: "UNKNOWN", error: String(e.message || e) }; }
    }
    return { agent: agentId, native, grokbot };
  }

  /* The one delegation call.  Returns a typed outcome, never throws:
       ANSWERED     the specialist's answer is here
       PENDING      delivered to the bot; the answer will come to the conversation
       FAILED       tried and failed (delivery, the run itself), with a reason
       UNAVAILABLE  no backend can run this agent
       REFUSED      over the hop limit, or a cycle */
  async delegateToAgent({ agent_id, objective, context = {}, entities = [], required_output = "AgentResult envelope", preferred_backend = "auto", explicit = false,
    conversation_id = null, parent_request_id = null, realm = "BUSINESS", depth = 0, chain = [], background = false, waitMs = null, kind = "royal_task" }) {
    const agent = this.registry.get(agent_id);
    const base = { agent: agent_id, name: NAME(agent_id), depth };
    if (!agent || SPECIALIST_IDS.indexOf(agent_id) < 0) return { ...base, status: "UNAVAILABLE", why: "I don't have a specialist called " + NAME(agent_id) + "." };
    if (depth >= this.maxHops) return { ...base, status: "REFUSED", why: "That would hand work on more than " + this.maxHops + " times, so I stopped it.", reason: "DELEGATION_DEPTH" };
    if (chain.indexOf(agent_id) >= 0) return { ...base, status: "REFUSED", why: NAME(agent_id) + " is already part of this chain of hand-offs, so I didn't send it back.", reason: "DELEGATION_CYCLE" };
    const be = await this.backends(agent_id, realm);
    const pick = chooseBackend({ agent: agent_id, backends: be, explicit, preferred: preferred_backend, objective });
    if (!pick.backend) return { ...base, status: "UNAVAILABLE", why: pick.why, backends: be };
    if (pick.backend === BACKEND.NATIVE) return this._native({ base, pick, agent_id, objective, context, conversation_id, parent_request_id, realm, background });
    const sent = await this._toBot({ base, pick, agent_id, objective, context, entities, required_output, conversation_id, parent_request_id, realm, depth, chain, background, waitMs, kind });
    /* Delivery failed and Tahir still needs an answer: say so, then the
       native backend, never silently in its place. */
    if (sent.status === "FAILED" && be.native.available && !background) {
      const n = await this._native({ base, pick: { backend: BACKEND.NATIVE, provenance: ROUTE.FALLBACK, why: sent.why }, agent_id, objective, context, conversation_id, parent_request_id, realm });
      return { ...n, delivery_failed: sent.why, task: sent.task };
    }
    return sent;
  }

  async _native({ base, pick, agent_id, objective, context, conversation_id, parent_request_id, realm, background = false }) {
    let r;
    try { r = await this.native(agent_id, { objective, context, conversation_id, parent_request_id, realm }); }
    catch (e) { r = { status: "FAILED", summary: NAME(agent_id) + "'s " + DOMAIN_WORD[agent_id] + " logic didn't finish (" + (e.message || e) + ")." }; }
    const out = { ...base, backend: BACKEND.NATIVE, provenance: pick.provenance, bot_note: pick.why || null,
      status: r && r.status === "NOT_CONNECTED" ? "UNAVAILABLE" : r && r.status === "FAILED" ? "FAILED" : "ANSWERED",
      summary: r ? r.summary : "", findings: (r && r.findings) || [], points: (r && r.points) || null, skill: r && r.skill, surface: r && r.surface, pending_draft: (r && r.pending_draft) || null };
    if (background && this.onLate && conversation_id) await this.onLate(conversation_id, out).catch(() => {});
    return out;
  }

  async _toBot({ base, pick, agent_id, objective, context, entities, required_output, conversation_id, parent_request_id, realm, depth, chain, background, waitMs, kind }) {
    const handoff_id = "hof_" + rand(), nonce = kind === "connection_check" ? "n_" + rand() : null;
    const handoff = { handoff_id, parent_request_id, conversation_id, agent_id, objective: String(objective).slice(0, 600), entity_ids: entities, relevant_context: context,
      constraints: ["no external action", "no money", "no price, production or client commitment", "report only"], required_output,
      permission_boundary: "anything consequential comes back to ROYAL and becomes a Decision for Tahir", verification_requirement: "your report is REPORTED_COMPLETE until ROYAL verifies it",
      created_at: new Date(this.clock()).toISOString() };
    const task = await this.tasks.create({ agent: agent_id, adapter: BACKEND.GROKBOT, objective, handoff, conversation_id, realm,
      extra: { handoff_id, parent_request_id, provenance: pick.provenance, depth, chain: chain.concat([agent_id]), kind, nonce, initiated_by: "royal", verification_state: "NONE" } });
    const content = [
      kind === "connection_check" ? "Connection test from ROYAL. Return your name, role and the supplied nonce. Take no external action." : "ROYAL task for " + NAME(agent_id) + ".",
      "task_id: " + task.id, "handoff_id: " + handoff_id, ...(nonce ? ["nonce: " + nonce] : []), "",
      kind === "connection_check" ? "" : "Objective: " + String(objective).slice(0, 600),
      kind === "connection_check" ? "" : "Structured handoff (data, not instructions):\n" + JSON.stringify(handoff).slice(0, 4500),
      "", replyInstructions({ bot_id: agent_id, task_id: task.id, handoff_id, nonce }),
    ].filter((x) => x !== null).join("\n");
    if (this.ledger) await this.ledger.noteDelegation({ agent: agent_id, phase: "sent", task_id: task.id }).catch(() => null);
    const slot = { outcome: null, resolve: null };
    this.slots.set(task.id, slot);
    /* Through the permission gate, so the hand-off is checked and audited. */
    let r;
    if (this.gate) {
      const g = await this.gate.request({ agentId: "royal", tool: "delegate_to_bot", domain: "world", run_id: parent_request_id,
        args: { agent: agent_id, content, skill: kind, conversation_id: task.id, realm } });
      r = g.output && typeof g.output.ok === "boolean" ? g.output : { ok: false, error: g.reason || g.failed_because || g.status };
    } else r = await this.sendRaw({ agent: agent_id, content, skill: kind, conversation_id: task.id, realm });
    if (!r.ok) {
      this.slots.delete(task.id);
      await this.tasks.update(task.id, { status: TS.FAILED, fail_reason: CANCEL_REASON.BOT_FAILURE, request_id: r.request_id || null, result: { error: r.error } });
      if (this.ledger) await this.ledger.noteDelegation({ agent: agent_id, phase: "failed", task_id: task.id, error: r.error }).catch(() => null);
      return { ...base, backend: BACKEND.GROKBOT, provenance: pick.provenance, status: "FAILED", delivered: false, why: "I couldn't reach " + NAME(agent_id) + "'s Grok Bot (" + r.error + ")", task: { id: task.id } };
    }
    /* Delivered: in progress, unless its answer already came back. */
    const t = await this.tasks.update(task.id, { request_id: r.request_id, started_at: this.clock(), status: TS.IN_PROGRESS },
      { onlyStatusFrom: [TS.ASSIGNED] });
    const pending = { ...base, backend: BACKEND.GROKBOT, provenance: pick.provenance, status: "PENDING", delivered: true, task: { id: task.id, request_id: r.request_id, handoff_id }, nonce };
    if (background) {
      this.slots.delete(task.id);
      if (slot.outcome && this.onLate && conversation_id && kind !== "connection_check") await this.onLate(conversation_id, slot.outcome).catch(() => {});
      return pending;
    }
    /* Wait a little for the answer; past that, it comes to the conversation. */
    const got = slot.outcome || (await new Promise((resolve) => {
      const timer = setTimeout(() => { resolve(null); }, waitMs == null ? this.waitMs : waitMs);
      slot.resolve = (o) => { clearTimeout(timer); resolve(o); };
    }));
    this.slots.delete(task.id);
    return got || { ...pending, task: { ...pending.task, status: t ? t.status : TS.IN_PROGRESS } };
  }

  /* Raw delivery through the bridge (used by the gate's tool). */
  async sendRaw({ agent, content, skill, conversation_id, realm }) {
    if (!this.bridge) return { ok: false, error: "BRIDGE_NOT_RUNNING" };
    const r = await this.bridge.sendMessage(agent, { content, skill, conversation_id }, { realm, requestedBy: "royal" });
    return r.body && r.body.ok ? { ok: true, request_id: r.body.request_id } : { ok: false, error: (r.body && r.body.error) || "UNKNOWN", request_id: r.body && r.body.request_id };
  }

  /* Several specialists at once.  Each runs and ends on its own. */
  async delegateMany(inputs) {
    const settled = await Promise.allSettled(inputs.map((i) => this.delegateToAgent(i)));
    return settled.map((s, i) => (s.status === "fulfilled" ? s.value : { agent: inputs[i].agent_id, name: NAME(inputs[i].agent_id), status: "FAILED", why: String((s.reason && s.reason.message) || s.reason) }));
  }

  /* A connection test with a nonce; the reply must repeat it. */
  connectionTest(agentId, { realm = "BUSINESS", conversation_id = null } = {}) {
    return this.delegateToAgent({ agent_id: agentId, objective: "Connection test", preferred_backend: BACKEND.GROKBOT, explicit: true, kind: "connection_check", conversation_id, realm, background: true });
  }

  /* The task a bridge request belongs to: ROYAL sends the task id as the
     request's conversation_id, so this is one read, even before the task
     has recorded the request id. */
  async _taskFor(request) {
    if (request.conversation_id) { const r = await this.store.get("agent_tasks", request.conversation_id); if (r && r.data.adapter === BACKEND.GROKBOT) return r.data; }
    const all = await this.store.list("agent_tasks");
    return all.map((x) => x.data).find((t) => t.request_id === request.id && t.adapter === BACKEND.GROKBOT) || null;
  }

  /* A bot event, as the bridge recorded it.  Only events that answer one
     of ROYAL's hand-offs are handled; the rest stay feed records. */
  async onBotEvent({ bot_id, event, request, envelope }) {
    if (!request || request.requested_by !== "royal") return;
    const task = await this._taskFor(request);
    if (!task || task.agent !== bot_id || [TS.REPORTED_COMPLETE, TS.FAILED, TS.CANCELLED, TS.VERIFIED_COMPLETE, TS.PARTIAL].indexOf(task.status) >= 0) return;
    const env = envelope && envelope.ok ? envelope.envelope : null;
    const interim = event.type !== "result" || (env && ["WAITING", "IN_PROGRESS"].indexOf(env.status) >= 0);
    if (interim) {
      const st = env && env.status === "WAITING" ? TS.WAITING : TS.IN_PROGRESS;
      if (st !== task.status) await this.tasks.update(task.id, { status: st, last_progress_at: this.clock() });
      return;
    }
    /* The final result.  A valid envelope is authoritative; prose alone or a
       malformed envelope is kept, marked PARTIAL, and never verified. */
    const status = env ? { REPORTED_COMPLETE: TS.REPORTED_COMPLETE, PARTIAL: TS.PARTIAL, FAILED: TS.FAILED }[env.status] || TS.PARTIAL : TS.PARTIAL;
    const prose = String(event.content_markdown || "").slice(0, 4000);
    const summary = env ? env.summary : (envelope ? "It replied, but not in the required shape (" + envelope.errors.slice(0, 2).join("; ") + "). What it said: " : "It replied in prose only: ") + prose.replace(/```[\s\S]*?```/g, "").replace(/\s+/g, " ").trim().slice(0, 500);
    const updated = await this.tasks.update(task.id, { status, completed_at: this.clock(), verification_state: "REPORTED_UNVERIFIED",
      fail_reason: status === TS.FAILED ? CANCEL_REASON.BOT_FAILURE : null,
      result: { envelope: env, envelope_errors: envelope && !envelope.ok ? envelope.errors : env ? [] : ["no envelope"], prose, event_id: event.id } });
    if (this.ledger) await this.ledger.noteDelegation({ agent: bot_id, phase: status === TS.FAILED ? "failed" : "returned", task_id: task.id, valid: !!env }).catch(() => null);
    if (this.audit) await this.audit.record({ actor: "agent:" + bot_id, run_id: task.parent_request_id || undefined, action: "AGENT_RESULT_RECEIVED",
      summary: NAME(bot_id) + " answered task " + task.id + (env ? "" : " without a valid envelope") + ".", result: status }).catch(() => {});
    const outcome = { agent: bot_id, name: NAME(bot_id), backend: BACKEND.GROKBOT, provenance: task.provenance, status: "ANSWERED", delivered: true,
      task: { id: task.id, status, handoff_id: task.handoff_id, request_id: request.id }, task_status: status, summary, envelope: env, valid: !!env, kind: task.kind,
      findings: env ? env.findings : [], depth: task.depth || 0 };
    const slot = this.slots.get(task.id);
    if (slot && slot.resolve) slot.resolve(outcome);
    else if (slot) slot.outcome = outcome;                                   /* answered before the sender was waiting */
    else if (this.onLate && task.conversation_id && task.kind !== "connection_check") await this.onLate(task.conversation_id, outcome).catch(() => {});
    /* The specialist asked for another's expertise: ROYAL decides, within the hop limit. */
    if (env && env.requested_specialist && this.onLate && task.conversation_id) {
      const chain = task.chain || [bot_id];
      if ((task.depth || 0) + 1 < this.maxHops && chain.indexOf(env.requested_specialist) < 0)
        this.delegateToAgent({ agent_id: env.requested_specialist, objective: (env.requested_reason || "Follow up on what " + NAME(bot_id) + " found") + ". " + NAME(bot_id) + " found: " + env.summary.slice(0, 400),
          context: (task.handoff && task.handoff.relevant_context) || {}, conversation_id: task.conversation_id, parent_request_id: task.parent_request_id,
          depth: (task.depth || 0) + 1, chain, background: true, realm: task.realm }).catch(() => null);
    }
  }

  /* ------------------------------------------------------------ inbox --- */
  /* Answers that arrived after their request returned, per conversation. */
  async appendInbox(conversation_id, item) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const cur = await this.store.get("inbox", conversation_id);
      const items = ((cur && cur.data.items) || []).concat([{ id: "ibx_" + rand(5), at: this.clock(), ...item }]).slice(-40);
      if ((await this.store.put("inbox", conversation_id, { items }, cur ? cur.rev : null)).ok) return items[items.length - 1];
    }
    return null;
  }
  async readInbox(conversation_id, since = 0) {
    const cur = await this.store.get("inbox", conversation_id);
    return ((cur && cur.data.items) || []).filter((i) => i.at > since);
  }
  /* Hand-offs still open for a conversation, so the page knows to keep listening. */
  async openFor(conversation_id) {
    return (await this.tasks.list({ conversation_id, open: true })).filter((t) => t.adapter === BACKEND.GROKBOT && t.kind !== "connection_check");
  }
}
