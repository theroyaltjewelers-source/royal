/* Live fan-out for bot events.

   A stream subscribes to one bot, or to the combined overview.  Publishing
   carries only {bot_id, event_id}; each receiving instance re-reads the row
   from its own store, so nothing but ids crosses the channel.

     LocalPubSub  one process (memory store, tests)
     PgPubSub     Postgres LISTEN/NOTIFY, so a stream on one Render instance
                  receives events recorded by another

   If the LISTEN connection drops, every open stream is told to reset; the
   browser reconnects with Last-Event-ID and the replay fills the gap. */

import { EventEmitter } from "node:events";

const CHANNEL = "grokbot_events";

class Base {
  constructor(store) { this.store = store; this.bus = new EventEmitter(); this.bus.setMaxListeners(500); }
  /* listener(event) for one bot (botId) or for all bots (null) */
  subscribe(botId, listener, onReset) {
    const ch = botId == null ? "all" : "bot:" + botId;
    this.bus.on(ch, listener); if (onReset) this.bus.on("reset", onReset);
    return () => { this.bus.off(ch, listener); if (onReset) this.bus.off("reset", onReset); };
  }
  async deliver(botId, eventId) {
    const evt = await this.store.getEvent(botId, eventId);
    if (!evt || evt.bot_id !== botId) return;          /* re-read under the bot's own id */
    this.bus.emit("bot:" + botId, evt); this.bus.emit("all", evt);
  }
}

export class LocalPubSub extends Base {
  async publish(botId, eventId) { await this.deliver(botId, eventId); }
  async start() {} async stop() {}
}

export class PgPubSub extends Base {
  constructor(store, pool, { logger = console } = {}) { super(store); this.pool = pool; this.logger = logger; this.client = null; this.stopped = false; this.retry = 1000; }
  async publish(botId, eventId) { await this.pool.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify({ bot_id: botId, event_id: String(eventId) })]); }
  async start() {
    this.stopped = false;
    const c = await this.pool.connect();
    this.client = c;
    c.on("notification", (m) => {
      if (m.channel !== CHANNEL) return;
      let p; try { p = JSON.parse(m.payload); } catch (_) { return; }
      if (!p || typeof p.bot_id !== "string" || !/^\d{1,20}$/.test(String(p.event_id))) return;
      /* one at a time, so streams see events in the order Postgres committed them */
      this.chain = (this.chain || Promise.resolve()).then(() => this.deliver(p.bot_id, p.event_id))
        .catch((e) => this.logger.warn && this.logger.warn("[grokbot] fan-out read failed: " + e.message));
    });
    c.on("error", () => this.lost());
    await c.query("LISTEN " + CHANNEL);
    this.retry = 1000;
  }
  lost() {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    try { this.client && this.client.release(true); } catch (_) {}
    this.client = null;
    this.bus.emit("reset");
    const t = setTimeout(() => { this.reconnecting = false; this.start().catch(() => this.lost()); }, this.retry);
    if (t.unref) t.unref();
    this.retry = Math.min(this.retry * 2, 30000);
  }
  async stop() {
    this.stopped = true;
    if (this.client) { try { await this.client.query("UNLISTEN " + CHANNEL); } catch (_) {} this.client.release(); this.client = null; }
  }
}
