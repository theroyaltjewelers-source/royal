/* The Royal T connector.  Receives House API snapshots from the calculator,
   keeps the latest and the one before it (the "what changed" pair), and
   serves ROYAL's read tools from them with their freshness attached. */

import { CONTRACT, validateSnapshot } from "./contract.js";
import { freshness, ageText, SourceHealth } from "../../../core/sources.js";
import { CONNECTION, EVIDENCE } from "../../../core/enums.js";
import { stableHash, clone } from "../../../core/util.js";

const LATEST = "royal_t:latest", PREVIOUS = "royal_t:previous", CHECKPOINT = "royal_t:checkpoint";

/* The House keeps Eastern time.  Day boundaries use a fixed offset supplied
   by configuration rather than whatever zone the server happens to run in. */
function dayOf(ms, offsetMin = -240) { return new Date(ms + offsetMin * 60000).toISOString().slice(0, 10); }

export class RoyalTConnector {
  constructor({ store, audit, health = new SourceHealth(), clock = () => Date.now(), tzOffsetMin = -240 }) {
    this.store = store; this.audit = audit; this.health = health; this.clock = clock; this.tzOffsetMin = tzOffsetMin;
    this.domain = "royal_t"; this.source = "calculator";
  }

  /* Accept a snapshot.  Idempotent: the same snapshot delivered twice is
     recognised by its digest and changes nothing the second time. */
  async ingest(snapshot, { actor = "calculator", transport = "embedded" } = {}) {
    const v = validateSnapshot(snapshot);
    if (!v.ok) {
      this.health.set(this.source, CONNECTION.ERROR, { detail: v.errors.slice(0, 5) });
      await this.audit.record({ actor, action: "INGEST_REJECTED", summary: "A calculator snapshot was refused: " + v.errors[0],
        error: v.errors.join("; "), executive: false });
      return { ok: false, attempted: "ingest calculator snapshot", failed_because: "INVALID_SNAPSHOT", errors: v.errors,
        impact: "I kept the last good snapshot.", retryable: false };
    }
    const digest = stableHash(snapshot.projects.map((p) => [p.id, p.stage, p.paid, p.value, p.due, p.health && p.health.s])
      .concat([snapshot.treasury && snapshot.treasury.inbox && snapshot.treasury.inbox.map((i) => i.key)]));
    const cur = await this.store.get("snapshots", LATEST);
    if (cur && cur.data.digest === digest) {
      /* Same content, newer reading: freshen the timestamp only. */
      const next = { ...cur.data, received_at: this.clock(), generated_at: snapshot.generated_at };
      await this.store.put("snapshots", LATEST, next, cur.rev);
      this.health.set(this.source, CONNECTION.CONNECTED, { last_ingest: this.clock(), transport });
      return { ok: true, changed: false, digest };
    }
    const rec = { digest, received_at: this.clock(), generated_at: snapshot.generated_at, transport, snapshot };
    if (cur) {
      const prev = await this.store.get("snapshots", PREVIOUS);
      await this.store.put("snapshots", PREVIOUS, cur.data, prev ? prev.rev : null);
    }
    const w = await this.store.put("snapshots", LATEST, rec, cur ? cur.rev : null);
    if (!w.ok) return { ok: false, attempted: "ingest", failed_because: "CONFLICT", retryable: true };
    this.health.set(this.source, CONNECTION.CONNECTED, { last_ingest: this.clock(), transport });
    /* The first state seen each day is kept as that day's baseline, so "what
       changed today" has something fixed to compare against. */
    const dayKey = "royal_t:day:" + dayOf(snapshot.generated_at, this.tzOffsetMin);
    if (!(await this.store.get("snapshots", dayKey))) await this.store.put("snapshots", dayKey, rec, null);
    await this.audit.record({ actor, action: "SNAPSHOT_INGESTED", summary: "Calculator state received: " + snapshot.projects.length + " projects.",
      result: digest, executive: false });
    return { ok: true, changed: true, digest };
  }

  async latest() { const r = await this.store.get("snapshots", LATEST); return r ? r.data : null; }
  async previous() { const r = await this.store.get("snapshots", PREVIOUS); return r ? r.data : null; }

  /* The state to compare against: where Tahir last looked, otherwise the
     start of today, otherwise the snapshot before this one. */
  async baseline(now = this.clock()) {
    const cp = await this.store.get("snapshots", CHECKPOINT);
    if (cp) return { basis: "since you last checked", rec: cp.data };
    const day = await this.store.get("snapshots", "royal_t:day:" + dayOf(now, this.tzOffsetMin));
    if (day) return { basis: "since the start of today", rec: day.data };
    const prev = await this.previous();
    return prev ? { basis: "since the previous reading", rec: prev } : { basis: null, rec: null };
  }

  /* Mark the current state as seen. */
  async checkpoint() {
    const l = await this.latest(); if (!l) return false;
    const cp = await this.store.get("snapshots", CHECKPOINT);
    await this.store.put("snapshots", CHECKPOINT, l, cp ? cp.rev : null);
    return true;
  }

  /* The status every answer carries: is the calculator connected, and how old
     is what ROYAL knows. */
  async status(now = this.clock()) {
    const l = await this.latest();
    if (!l) return { connected: false, status: CONNECTION.NOT_CONNECTED, freshness: "UNKNOWN", age: "never verified", contract: CONTRACT };
    const at = l.generated_at;
    return { connected: true, status: CONNECTION.CONNECTED, freshness: freshness("PROJECT_STATUS", at, now), age: ageText(at, now),
      verified_at: at, transport: l.transport, contract: CONTRACT,
      partial: !!(l.snapshot.load && l.snapshot.load.capped), partial_notes: (l.snapshot.load && l.snapshot.load.notes) || [] };
  }

  /* Read tools, as the tool registry sees them.  Each returns
     {ok, data, evidence:{label, source, verified_at, freshness}}. */
  tools() {
    const self = this;
    async function read(pick) {
      const l = await self.latest();
      if (!l) return { ok: false, attempted: "read calculator", failed_because: "CALCULATOR_NOT_CONNECTED",
        impact: "No project, client or payment conclusion can be drawn.", next_action: "Open the calculator signed in, or connect it to me." };
      const now = self.clock();
      return { ok: true, data: clone(pick(l.snapshot)), evidence: { label: EVIDENCE.VERIFIED, source: "calculator",
        verified_at: l.generated_at, freshness: freshness("PROJECT_STATUS", l.generated_at, now), age: ageText(l.generated_at, now) } };
    }
    const live = (s) => s.projects.filter((p) => !p.archived && !p.deleted && p.stage !== "Archived");
    return {
      get_active_projects: () => read(live),
      get_project: ({ id }) => read((s) => s.projects.find((p) => p.id === id) || null),
      get_client: ({ id }) => read((s) => s.clients.find((c) => c.id === id) || null),
      get_production_status: () => read((s) => live(s).filter((p) => ["CAD", "Awaiting approval", "Deposit due", "Production", "Quality control", "Ready"].indexOf(p.stage) >= 0)),
      get_outstanding_balances: () => read((s) => live(s).filter((p) => p.outstanding > 0.005)),
      get_expected_payments: () => read((s) => live(s).filter((p) => p.capital > p.paid || (p.outstanding > 0 && ["Ready", "Quality control", "Balance due"].indexOf(p.stage) >= 0))),
      get_treasury: () => read((s) => s.treasury),
      get_sales_pipeline: () => read((s) => live(s).filter((p) => ["Inquiry", "Design"].indexOf(p.stage) >= 0)),
      get_upcoming_deadlines: () => read((s) => live(s).filter((p) => p.due)),
    };
  }
}
