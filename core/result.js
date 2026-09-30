/* The structured agent result.  Everything an agent concludes comes back in
   this shape, so the application reads fields, never prose, to decide whether
   something needs Tahir or needs approval. */

import { PRIORITY, PRIORITY_RANK, RISK, RISK_RANK, RUN_STATUS, NEED, EVIDENCE } from "./enums.js";

export function topPriority(items) {
  return items.reduce((best, i) => (PRIORITY_RANK[i.priority] < PRIORITY_RANK[best] ? i.priority : best), PRIORITY.P4);
}
export function topRisk(items) {
  return items.reduce((best, i) => (RISK_RANK[i.risk] > RISK_RANK[best] ? i.risk : best), RISK.GREEN);
}

export function agentResult({ agent, run_id, status = RUN_STATUS.OK, summary = "", findings = [], confidence = null,
  sources = [], entities = [], next_actions = [], delegated_actions = [], unresolved_questions = [], timestamp = Date.now(), surface = null, data = null }) {
  const needsTahir = findings.some((f) => f.need && f.need !== NEED.NONE && f.need !== NEED.MONITOR);
  const needsApproval = findings.some((f) => f.need === NEED.APPROVE);
  return {
    agent, run_id, status, summary,
    findings, priority: topPriority(findings), risk: topRisk(findings),
    confidence, requires_tahir: needsTahir, requires_approval: needsApproval,
    sources, entities: Array.from(new Set(entities.concat(findings.map((f) => f.entity && f.entity.id).filter(Boolean)))),
    next_actions, delegated_actions, unresolved_questions, timestamp,
    surface, data,
  };
}

const REQUIRED = ["agent", "run_id", "status", "summary", "findings", "priority", "risk", "requires_tahir", "requires_approval", "sources", "timestamp"];

export function validateResult(r) {
  const errors = [];
  if (!r || typeof r !== "object") return { ok: false, errors: ["not an object"] };
  REQUIRED.forEach((f) => { if (r[f] === undefined) errors.push("missing " + f); });
  if (r.status && !RUN_STATUS[r.status]) errors.push("unknown status " + r.status);
  if (r.priority && !PRIORITY[r.priority]) errors.push("unknown priority " + r.priority);
  if (r.risk && !RISK[r.risk]) errors.push("unknown risk " + r.risk);
  (r.findings || []).forEach((f, i) => {
    if (!f.title) errors.push("findings[" + i + "] has no title");
    if (!f.evidence || !EVIDENCE[f.evidence.label]) errors.push("findings[" + i + "] has no evidence label");
    if (f.evidence && f.evidence.label === EVIDENCE.VERIFIED && !f.evidence.source) errors.push("findings[" + i + "] claims VERIFIED with no source");
  });
  return { ok: errors.length === 0, errors };
}
