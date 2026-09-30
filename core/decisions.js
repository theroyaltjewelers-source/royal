/* Decisions, approvals and the consequence gate.

     AGENT REQUEST -> PERMISSION CHECK -> approval required?
        no  -> EXECUTE -> VERIFY -> AUDIT
        yes -> DECISION (inbox) -> TAHIR resolves -> EXECUTE -> VERIFY -> AUDIT

   The model never grants itself authority.  Approval exists only as a
   Decision resolved by an owner; silence, delay and ambiguous language
   resolve nothing. */

import { DECISION_STATUS as S, DECISION_TYPE, PRIORITY, RISK, REVERSIBILITY } from "./enums.js";
import { stableHash, clone } from "./util.js";

export function failure({ attempted, failed_because, impact, retryable = false, next_action }) {
  return { ok: false, attempted, result: "FAILED", failed_because, impact: impact || null, retryable: !!retryable, next_action: next_action || null };
}

const TOOL_TO_DECISION = {
  send_client_message: DECISION_TYPE.SEND_CLIENT_MESSAGE, issue_refund: DECISION_TYPE.REFUND,
  vendor_payment: DECISION_TYPE.VENDOR_PAYMENT, change_project_price: DECISION_TYPE.PRICING_EXCEPTION,
  approve_rush_request: DECISION_TYPE.RUSH_REQUEST, production_change: DECISION_TYPE.PRODUCTION_CHANGE,
  deploy_production: DECISION_TYPE.DEPLOYMENT, change_policy: DECISION_TYPE.POLICY_CHANGE,
};

export class DecisionService {
  constructor({ store, audit, clock = () => Date.now() }) {
    this.store = store; this.audit = audit; this.clock = clock;
    this.executors = new Map();
  }

  /* An executor carries out an approved action and says how to check it
     worked.  A tool with no executor can still be approved; ROYAL then says
     plainly that a person has to carry it out. */
  registerExecutor(tool, fn) { this.executors.set(tool, fn); }

  /* Idempotent: the same dedupe key while a decision is still open returns
     that decision instead of raising a second card for the same question. */
  async create(d) {
    for (const f of ["type", "title", "requested_by_agent"]) if (!d[f]) throw new Error("DECISION_INVALID: " + f + " is required");
    if (!DECISION_TYPE[d.type]) throw new Error("DECISION_INVALID: unknown type " + d.type);
    const key = d.dedupe_key || stableHash({ t: d.type, a: d.action || null, p: d.related_project_id || null, title: d.title });
    const id = "dec_" + stableHash(key);
    const existing = await this.store.get("decisions", id);
    if (existing && existing.data.status === S.OPEN) return { created: false, decision: existing.data };

    const rec = {
      id, dedupe_key: key, type: d.type, title: d.title, description: d.description || "",
      requested_by_agent: d.requested_by_agent, realm: d.realm || "BUSINESS", domain: d.domain || null,
      related_client_id: d.related_client_id || null, related_project_id: d.related_project_id || null,
      priority: d.priority || PRIORITY.P2, risk: d.risk || RISK.YELLOW,
      facts: d.facts || [], unknowns: d.unknowns || [], options: d.options || ["APPROVE", "MODIFY", "REJECT"],
      recommended_option: d.recommended_option || null, reasoning_summary: d.reasoning_summary || "",
      financial_impact: d.financial_impact === undefined ? null : d.financial_impact,
      deadline: d.deadline || null, reversibility: d.reversibility || REVERSIBILITY.REVERSIBLE,
      expected_result: d.expected_result || null, source: d.source || null,
      action: d.action || null,
      status: S.OPEN, created_at: this.clock(), resolved_at: null, resolved_by: null, resolution: null,
      execution: null,
    };
    /* Reopening a closed decision with the same key keeps its history under a
       new revision rather than a new identity. */
    const w = await this.store.put("decisions", id, rec, existing ? existing.rev : null);
    if (!w.ok) return { created: false, decision: w.current && w.current.data, conflict: true };
    await this.audit.record({ actor: d.requested_by_agent, agent: d.requested_by_agent, action: "DECISION_CREATED",
      summary: "Decision needed: " + d.title, entities: [d.related_project_id, d.related_client_id].filter(Boolean),
      tool: d.action && d.action.tool, executive: true, key: id, run_id: d.run_id });
    return { created: true, decision: rec };
  }

  async get(id) { const r = await this.store.get("decisions", id); return r ? r.data : null; }

  async list({ status, realm } = {}) {
    const all = (await this.store.list("decisions")).map((r) => r.data).filter((d) => !realm || (d.realm || "BUSINESS") === realm);
    return (status ? all.filter((d) => d.status === status) : all).sort((a, b) => b.created_at - a.created_at);
  }

  /* resolution: "APPROVE" | "MODIFY" | "REJECT".  `actor` must be an owner. */
  async resolve(id, { actor, resolution, modified_args, note }) {
    if (!actor || actor.role !== "owner") return failure({ attempted: "resolve " + id, failed_because: "ONLY_OWNER_MAY_RESOLVE", impact: "Nothing changed." });
    if (["APPROVE", "MODIFY", "REJECT"].indexOf(resolution) < 0) return failure({ attempted: "resolve " + id, failed_because: "UNKNOWN_RESOLUTION" });

    const cur = await this.store.get("decisions", id);
    if (!cur) return failure({ attempted: "resolve " + id, failed_because: "DECISION_NOT_FOUND" });
    if (cur.data.status !== S.OPEN) return failure({ attempted: "resolve " + id, failed_because: "ALREADY_" + cur.data.status, impact: "Nothing changed. It was resolved before." });

    const d = clone(cur.data);
    d.resolved_at = this.clock(); d.resolved_by = actor.id; d.resolution = { kind: resolution, note: note || null };
    if (resolution === "REJECT") d.status = S.REJECTED;
    else {
      d.status = resolution === "MODIFY" ? S.MODIFIED : S.APPROVED;
      if (resolution === "MODIFY" && d.action) d.action = { ...d.action, args: { ...(d.action.args || {}), ...(modified_args || {}) } };
    }
    const w = await this.store.put("decisions", id, d, cur.rev);
    if (!w.ok) return failure({ attempted: "resolve " + id, failed_because: "CONFLICT", impact: "Someone resolved it at the same moment. Nothing was executed.", retryable: true });

    await this.audit.record({ actor: "tahir", action: "DECISION_" + d.status, summary: d.title + ": " + d.status.toLowerCase(),
      approval: { resolution, by: actor.id }, entities: [d.related_project_id].filter(Boolean), executive: true, key: id });

    if (d.status === S.REJECTED || !d.action) return { ok: true, decision: d };
    return this._execute(d, w.rev);
  }

  async _execute(d, rev) {
    const fn = this.executors.get(d.action.tool);
    let execution;
    if (!fn) {
      execution = { result: "NO_EXECUTOR", failed_because: "ROYAL has no connected way to carry out " + d.action.tool + " in this version.",
        next_action: "A person carries this out. The approval is recorded." };
    } else {
      try {
        const r = await fn(d.action.args || {}, { decision: d });
        let verified = null;
        if (r && typeof r.verify === "function") {
          try { verified = !!(await r.verify()); } catch (e) { verified = false; }
        }
        execution = { result: r && r.ok ? "EXECUTED" : "FAILED", detail: r && r.detail || null,
          failed_because: r && !r.ok ? (r.failed_because || "EXECUTOR_REPORTED_FAILURE") : null, verified };
      } catch (e) {
        execution = { result: "FAILED", failed_because: String(e.message || e), retryable: true, verified: false };
      }
    }
    const next = clone(d);
    next.execution = { ...execution, at: this.clock() };
    next.status = execution.result === "EXECUTED" ? (execution.verified === false ? S.FAILED : execution.verified ? S.VERIFIED : S.EXECUTED)
      : execution.result === "NO_EXECUTOR" ? next.status : S.FAILED;
    await this.store.put("decisions", d.id, next, rev);
    await this.audit.record({ actor: "royal", action: "ACTION_" + (execution.result === "EXECUTED" ? (execution.verified === false ? "VERIFICATION_FAILED" : "EXECUTED") : execution.result),
      summary: d.title + ": " + (execution.failed_because || "done"), tool: d.action.tool, result: execution.result,
      verification: execution.verified, executive: true, key: d.id });
    return { ok: execution.result === "EXECUTED" && execution.verified !== false, decision: next, execution };
  }
}

/* The consequence gate.  Every tool call from every agent passes through
   here.  Reads and analysis run; approval-class actions become decisions;
   everything else is refused and the refusal is recorded. */
export class ConsequenceGate {
  constructor({ permissions, decisions, audit, tools }) {
    this.permissions = permissions; this.decisions = decisions; this.audit = audit; this.tools = tools;
  }

  async request({ agentId, tool, args = {}, domain, run_id, decision }) {
    const verdict = this.permissions.check({ agentId, tool, domain });
    if (verdict.allowed) {
      const impl = this.tools.get(tool);
      if (!impl) {
        await this.audit.record({ agent: agentId, actor: agentId, run_id, action: "TOOL_UNAVAILABLE", tool, permission: verdict });
        return { status: "FAILED", ...failure({ attempted: tool, failed_because: "TOOL_NOT_CONNECTED", impact: "No data from this tool was used." }) };
      }
      try {
        const out = await impl(args, { agentId, domain, run_id });
        await this.audit.record({ agent: agentId, actor: agentId, run_id, action: "TOOL_CALLED", tool, permission: verdict, result: out && out.ok === false ? "FAILED" : "OK" });
        return { status: out && out.ok === false ? "FAILED" : "OK", output: out };
      } catch (e) {
        await this.audit.record({ agent: agentId, actor: agentId, run_id, action: "TOOL_FAILED", tool, error: e });
        return { status: "FAILED", ...failure({ attempted: tool, failed_because: String(e.message || e), retryable: true, impact: "No conclusion was drawn from this tool." }) };
      }
    }
    if (verdict.requiresApproval) {
      const pol = verdict;
      const tmpl = decision || {};
      const r = await this.decisions.create({
        type: tmpl.type || (verdict.reason === "INTERNAL_WRITE_DISABLED" ? DECISION_TYPE.INTERNAL_ACTION : (TOOL_TO_DECISION[tool] || DECISION_TYPE.GENERAL)),
        title: tmpl.title || ("Approve " + tool.replace(/_/g, " ")),
        requested_by_agent: agentId, run_id, domain,
        reversibility: pol.reversibility, action: { tool, args, domain: domain || null },
        ...tmpl,
      });
      return { status: "PENDING_APPROVAL", decision: r.decision, created: r.created };
    }
    await this.audit.record({ agent: agentId, actor: agentId, run_id, action: "PERMISSION_DENIED", tool, permission: verdict,
      summary: agentId + " was refused " + tool + " (" + verdict.reason + ")", executive: verdict.reason === "PROHIBITED" });
    return { status: "DENIED", reason: verdict.reason };
  }
}
