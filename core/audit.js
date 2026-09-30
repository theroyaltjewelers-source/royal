/* The activity ledger and the audit trail are one append-only log with two
   readers.  Tahir's view shows only entries marked `executive` (what happened
   and what it means); the developer view shows everything, including tool
   calls and permission denials.  Nothing here can be edited or removed. */

import { redact } from "./util.js";

export class AuditService {
  constructor(store, clock = () => Date.now()) { this.store = store; this.clock = clock; }

  async record(e) {
    if (!e || !e.action) throw new Error("AUDIT_INVALID: action is required");
    const rec = redact({
      at: this.clock(),
      actor: e.actor || "royal",           /* who did it: an agent id, "tahir", or "system" */
      agent: e.agent || null,
      run_id: e.run_id || null,
      trigger: e.trigger || null,
      action: e.action,                     /* short machine name, e.g. DECISION_CREATED */
      summary: e.summary || "",             /* one human sentence */
      tool: e.tool || null,
      entities: e.entities || [],
      permission: e.permission || null,
      approval: e.approval || null,
      result: e.result || null,
      verification: e.verification || null,
      error: e.error ? String(e.error.message || e.error) : null,
      executive: !!e.executive,
      key: e.key || null,
    });
    return this.store.append("audit", rec);
  }

  async executiveLedger({ limit = 100 } = {}) {
    return (await this.store.readLog("audit", { limit: 5000 })).filter((r) => r.executive).slice(-limit).reverse();
  }

  async developerLog({ limit = 500 } = {}) {
    return (await this.store.readLog("audit", { limit })).reverse();
  }
}
