/* The permission engine.  Authority lives here, in code, not in any prompt.
   A model can ask for anything; only what this file allows is ever done.

   Every tool ROYAL knows is listed with its class and how reversible its
   effect is.  A tool that is not listed does not exist. */

import { PERMISSION as P, REVERSIBILITY as R } from "./enums.js";
import { deepFreeze } from "./util.js";

export const TOOL_POLICY = deepFreeze({
  /* reads */
  get_active_projects:     { cls: P.READ, rev: R.REVERSIBLE },
  get_project:             { cls: P.READ, rev: R.REVERSIBLE },
  get_client:              { cls: P.READ, rev: R.REVERSIBLE },
  get_production_status:   { cls: P.READ, rev: R.REVERSIBLE },
  get_outstanding_balances:{ cls: P.READ, rev: R.REVERSIBLE },
  get_expected_payments:   { cls: P.READ, rev: R.REVERSIBLE },
  get_treasury:            { cls: P.READ, rev: R.REVERSIBLE },
  get_upcoming_deadlines:  { cls: P.READ, rev: R.REVERSIBLE },
  get_open_commitments:    { cls: P.READ, rev: R.REVERSIBLE },
  get_waiting_items:       { cls: P.READ, rev: R.REVERSIBLE },
  get_recent_activity:     { cls: P.READ, rev: R.REVERSIBLE },
  get_sales_pipeline:      { cls: P.READ, rev: R.REVERSIBLE },
  get_decisions:           { cls: P.READ, rev: R.REVERSIBLE },
  get_system_status:       { cls: P.READ, rev: R.REVERSIBLE },
  /* intelligence: reading the world and the House's own documents */
  web_search:              { cls: P.READ, rev: R.REVERSIBLE, external_read: true },
  web_fetch:               { cls: P.READ, rev: R.REVERSIBLE, external_read: true },
  x_search:                { cls: P.READ, rev: R.REVERSIBLE, external_read: true },
  company_search:          { cls: P.READ, rev: R.REVERSIBLE, external_read: true },
  person_search:           { cls: P.READ, rev: R.REVERSIBLE, external_read: true },
  email_find:              { cls: P.READ, rev: R.REVERSIBLE, external_read: true, paid: true },
  email_verify:            { cls: P.READ, rev: R.REVERSIBLE, external_read: true, paid: true },
  knowledge_search:        { cls: P.READ, rev: R.REVERSIBLE },
  calculate:               { cls: P.ANALYZE, rev: R.REVERSIBLE },
  /* analysis */
  analyze_project_risk:    { cls: P.ANALYZE, rev: R.REVERSIBLE },
  get_production_risk:     { cls: P.ANALYZE, rev: R.REVERSIBLE },
  /* drafts: produce text, send nothing */
  draft_client_update:     { cls: P.DRAFT, rev: R.REVERSIBLE },
  draft_client_message:    { cls: P.DRAFT, rev: R.REVERSIBLE },
  draft_email:             { cls: P.DRAFT, rev: R.REVERSIBLE },
  delegate_to_bot:         { cls: P.DRAFT, rev: R.REVERSIBLE },   /* asks an external Grok Bot for work; its reply is a record only */
  /* ROYAL's own records */
  request_approval:        { cls: P.INTERNAL_WRITE, rev: R.REVERSIBLE, alwaysAllowed: true },
  create_internal_task:    { cls: P.INTERNAL_WRITE, rev: R.REVERSIBLE },
  record_commitment:       { cls: P.INTERNAL_WRITE, rev: R.REVERSIBLE },
  record_waiting:          { cls: P.INTERNAL_WRITE, rev: R.REVERSIBLE },
  /* consequential: never without Tahir */
  send_client_message:     { cls: P.APPROVAL_REQUIRED, rev: R.IRREVERSIBLE, external: true },
  send_email:              { cls: P.APPROVAL_REQUIRED, rev: R.IRREVERSIBLE, external: true },
  create_crm_lead:         { cls: P.APPROVAL_REQUIRED, rev: R.REVERSIBLE },
  issue_refund:            { cls: P.APPROVAL_REQUIRED, rev: R.DIFFICULT_TO_REVERSE, external: true, money: true },
  vendor_payment:          { cls: P.APPROVAL_REQUIRED, rev: R.DIFFICULT_TO_REVERSE, external: true, money: true },
  change_project_price:    { cls: P.APPROVAL_REQUIRED, rev: R.PARTIALLY_REVERSIBLE },
  approve_rush_request:    { cls: P.APPROVAL_REQUIRED, rev: R.PARTIALLY_REVERSIBLE },
  production_change:       { cls: P.APPROVAL_REQUIRED, rev: R.DIFFICULT_TO_REVERSE },
  deploy_production:       { cls: P.APPROVAL_REQUIRED, rev: R.PARTIALLY_REVERSIBLE },
  change_policy:           { cls: P.APPROVAL_REQUIRED, rev: R.REVERSIBLE },
  /* never */
  delete_financial_record: { cls: P.PROHIBITED, rev: R.IRREVERSIBLE },
  delete_client_record:    { cls: P.PROHIBITED, rev: R.IRREVERSIBLE },
  move_money_autonomously: { cls: P.PROHIBITED, rev: R.IRREVERSIBLE },
});

/* V1 safety mode.  Immature capabilities are off until Tahir turns them on. */
export const DEFAULT_FLAGS = deepFreeze({
  agent_internal_write: false,   /* off: internal writes become approval requests */
  agent_external_send: false,    /* off: even approved sends have no executor */
  proactive_monitoring: false,
  voice_input: false,
  automated_followup: false,
  production_risk_engine: true,  /* read-only analysis, safe */
  llm_synthesis: true,           /* use the model when one is connected */
  /* intelligence layer: read-only research is on (it still needs a provider
     key); anything that costs per call, reaches people, or is incomplete is off */
  web_research: true,
  x_search: false,
  people_research: true,
  email_discovery: false,        /* paid contact providers (Hunter, Apollo) */
  email_verification: false,     /* paid verification (Hunter) */
  realtime_voice: false,         /* xAI realtime voice; needs XAI_API_KEY */
  /* One voice on every device: ROYAL's spoken replies come from xAI text to
     speech instead of each device's own voices.  On at Tahir's request (30
     September 2026) although it costs per reply; Business only; needs
     XAI_API_KEY; the device voice takes over whenever it cannot answer. */
  spoken_voice: true,
  advanced_agent_orchestration: false,  /* delegating to external Grok Bots from ROYAL's router */
});

const WILDCARD = { [P.READ]: "*read", [P.ANALYZE]: "*analyze", [P.DRAFT]: "*draft" };

export class PermissionService {
  constructor(registry, flags = DEFAULT_FLAGS) { this.registry = registry; this.flags = { ...DEFAULT_FLAGS, ...flags }; }

  /* Returns a verdict, never throws.  `allowed` means execute now.
     `requiresApproval` means the only legitimate next step is a Decision. */
  check({ agentId, tool, domain }) {
    const deny = (reason, extra = {}) => ({ allowed: false, requiresApproval: false, reason, tool, agentId, ...extra });
    const pol = TOOL_POLICY[tool];
    if (!pol) return deny("UNKNOWN_TOOL");
    const base = { permission: pol.cls, reversibility: pol.rev };
    if (pol.cls === P.PROHIBITED) return deny("PROHIBITED", base);

    const agent = this.registry.get(agentId);
    if (!agent) return deny("UNKNOWN_AGENT", base);
    if (agent.status !== "ACTIVE") return deny("AGENT_INACTIVE", base);

    const listed = agent.allowed_tools.indexOf(tool) >= 0
      || (WILDCARD[pol.cls] && agent.allowed_tools.indexOf(WILDCARD[pol.cls]) >= 0);
    if (!listed && !pol.alwaysAllowed) return deny("TOOL_NOT_IN_CHARTER", base);

    if (domain && !this.registry.covers(agentId, domain)) return deny("REALM_BOUNDARY", base);

    if (pol.cls === P.APPROVAL_REQUIRED)
      return { allowed: false, requiresApproval: true, reason: "APPROVAL_REQUIRED", tool, agentId, ...base };

    if (pol.cls === P.INTERNAL_WRITE && !pol.alwaysAllowed && !this.flags.agent_internal_write)
      return { allowed: false, requiresApproval: true, reason: "INTERNAL_WRITE_DISABLED", tool, agentId, ...base };

    return { allowed: true, requiresApproval: false, reason: "OK", tool, agentId, ...base };
  }
}
