// ROYAL <-> Grok Bot bridge v2: storage.
//
// TODO(ROYAL DB): MemoryStore loses everything on restart/redeploy and is not
// shared between instances. Swap it for a class backed by ROYAL's database that
// implements the same async interface, then pass it in:
//     createBridge({ store: new RoyalDbStore(db) })
//
// BridgeStore interface (every method async so a DB can drop in):
//   appendEvent(event)                   -> stored event, adds { id, created_at }
//        ids must be strings that sort increasingly (e.g. a bigserial as text)
//   listEvents({ botId, since, limit })  -> events ascending by id;
//        botId null = all bots; since = event id or ISO time (exclusive);
//        with since -> first `limit` after it, without -> latest `limit`
//   putRequest(request) / getRequest(requestId) / updateRequest(requestId, patch)
//        request = { request_id, bot_id, skill, conversation_id, status, ... }
//   touchBot(botId, patch) / getBotState(botId)
//        state = { last_seen, last_message_at, last_error }
//
// Suggested tables:
//   grokbot_events(id bigserial pk, bot_id text not null, direction text,
//                  type text, content_markdown text, status text,
//                  request_id text, conversation_id text, skill text,
//                  author text, created_at timestamptz default now())
//   index on (bot_id, id)
//   grokbot_requests(request_id text pk, bot_id text not null, skill text,
//                    conversation_id text, status text, result_markdown text,
//                    requested_at timestamptz, updated_at timestamptz)
//   grokbot_bot_state(bot_id text pk, last_seen timestamptz,
//                     last_message_at timestamptz, last_error text)
// Always filter by bot_id in every query: that is the isolation boundary.

function matchesSince(evt, since) {
  if (since == null || since === "") return true;
  if (/^\d+$/.test(String(since))) return Number(evt.id) > Number(since);
  const t = Date.parse(since);
  return Number.isNaN(t) ? true : Date.parse(evt.created_at) > t;
}

export class MemoryStore {
  constructor({ maxEventsPerBot = 500, maxRequests = 5000 } = {}) {
    this.maxEventsPerBot = maxEventsPerBot;
    this.maxRequests = maxRequests;
    this.seq = 0;
    this.events = new Map();   // bot_id -> [event]  (ring buffer per bot)
    this.requests = new Map(); // request_id -> request (insertion-ordered, capped)
    this.botState = new Map(); // bot_id -> state
  }

  async appendEvent(event) {
    const stored = Object.freeze({ ...event, id: String(++this.seq), created_at: new Date().toISOString() });
    let list = this.events.get(stored.bot_id);
    if (!list) this.events.set(stored.bot_id, (list = []));
    list.push(stored);
    if (list.length > this.maxEventsPerBot) list.splice(0, list.length - this.maxEventsPerBot);
    return stored;
  }

  async listEvents({ botId = null, since = null, limit = 100 } = {}) {
    const source = botId == null
      ? [...this.events.values()].flat().sort((a, b) => Number(a.id) - Number(b.id))
      : this.events.get(botId) || [];
    const filtered = source.filter((e) => matchesSince(e, since));
    return since != null && since !== "" ? filtered.slice(0, limit) : filtered.slice(-limit);
  }

  async putRequest(request) {
    this.requests.set(request.request_id, { ...request });
    while (this.requests.size > this.maxRequests) this.requests.delete(this.requests.keys().next().value);
  }

  async getRequest(requestId) {
    const r = this.requests.get(requestId);
    return r ? { ...r } : null;
  }

  async updateRequest(requestId, patch) {
    const r = this.requests.get(requestId);
    if (r) Object.assign(r, patch);
  }

  async touchBot(botId, patch) {
    this.botState.set(botId, { ...(this.botState.get(botId) || {}), ...patch });
  }

  async getBotState(botId) {
    return { ...(this.botState.get(botId) || {}) };
  }
}
