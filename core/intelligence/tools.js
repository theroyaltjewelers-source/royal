/* The Tool Registry: one catalogue of every tool ROYAL knows, with what it
   does, what it costs, how risky it is and whether it is configured now.

   Authority is not here.  The permission class and reversibility come from
   TOOL_POLICY in core/permissions.js, the only place authority lives; this
   file describes tools, it does not permit them.  A test fails if a tool in
   TOOL_POLICY has no entry here, or the other way round. */

import { TOOL_POLICY } from "../permissions.js";
import { PERMISSION as P } from "../enums.js";

const T = (category, description, o = {}) => ({ category, description, cost: "none", latency: "fast", source_type: "internal", requires_auth: false, idempotent: true, audit: "log", ...o });

export const TOOL_META = {
  get_active_projects: T("HOUSE", "Active commissions from the Project Calculator."),
  get_project: T("HOUSE", "One commission by ID."),
  get_client: T("HOUSE", "One client by ID."),
  get_production_status: T("HOUSE", "Production stages and attention."),
  get_outstanding_balances: T("FINANCE", "What each client owes, from the calculator."),
  get_expected_payments: T("FINANCE", "Expected payments by date."),
  get_treasury: T("FINANCE", "Bills, debts, capital and runway from the calculator's Treasury."),
  get_upcoming_deadlines: T("HOUSE", "Target dates and promised dates."),
  get_open_commitments: T("HOUSE", "Commitments recorded in ROYAL or implied by target dates."),
  get_waiting_items: T("HOUSE", "What the House is waiting on."),
  get_recent_activity: T("HOUSE", "ROYAL's executive activity ledger."),
  get_sales_pipeline: T("HOUSE", "Inquiry-stage commissions (the pipeline until a CRM exists)."),
  get_decisions: T("HOUSE", "Decisions and their status."),
  get_system_status: T("ENGINEERING", "Connector and provider health."),
  web_search: T("RESEARCH", "Server-side web search through the configured model provider, with the sources it read.", { cost: "per call", latency: "slow", source_type: "public_web", requires_auth: true, audit: "log_query_and_sources" }),
  web_fetch: T("RESEARCH", "Fetch one public page as text, with SSRF protection, for cross-checking.", { latency: "medium", source_type: "public_web", audit: "log_url" }),
  x_search: T("RESEARCH", "Search posts on X through the provider. For sentiment and news, never for corporate facts on its own.", { cost: "per call", latency: "slow", source_type: "social", requires_auth: true }),
  company_search: T("RESEARCH", "Resolve a company's exact identity and official domain.", { cost: "per call", latency: "slow", source_type: "public_web", requires_auth: true }),
  person_search: T("RESEARCH", "Find who holds a role at a company now, and cross-check it.", { cost: "per call", latency: "slow", source_type: "public_web", requires_auth: true }),
  email_find: T("RESEARCH", "Find a professional business email (public page, Hunter, Apollo, pattern).", { cost: "paid per lookup", latency: "slow", source_type: "licensed_provider", requires_auth: true, audit: "log_status_only" }),
  email_verify: T("RESEARCH", "Classify an email's deliverability (Hunter).", { cost: "paid per lookup", latency: "slow", source_type: "licensed_provider", requires_auth: true, audit: "log_status_only" }),
  knowledge_search: T("HOUSE", "Search the House's own documents: bible, policies, constitutions, skills, cases."),
  calculate: T("HOUSE", "Deterministic arithmetic. No model."),
  analyze_project_risk: T("HOUSE", "Risk analysis over one commission."),
  get_production_risk: T("HOUSE", "Production risk engine."),
  draft_client_update: T("COMMUNICATION", "Draft a client update. Sends nothing."),
  draft_client_message: T("COMMUNICATION", "Draft a client message. Sends nothing."),
  draft_email: T("COMMUNICATION", "Draft an external email. Sends nothing.", { latency: "medium" }),
  delegate_to_bot: T("AGENTS", "Ask an external Grok Bot for work through the bridge; its reply is a record only.", { latency: "async", source_type: "agent", requires_auth: true, idempotent: false, audit: "log" }),
  request_approval: T("HOUSE", "Create a Decision for Tahir."),
  create_internal_task: T("HOUSE", "Create an internal task (idempotent by source).", { audit: "executive" }),
  record_commitment: T("HOUSE", "Record a commitment.", { audit: "executive" }),
  record_waiting: T("HOUSE", "Record a waiting dependency.", { audit: "executive" }),
  send_client_message: T("COMMUNICATION", "Send a message to a client.", { latency: "medium", source_type: "external_action", requires_auth: true, audit: "executive" }),
  send_email: T("COMMUNICATION", "Send an external email through the configured provider (Resend), once, with an idempotency key.", { cost: "per send", latency: "medium", source_type: "external_action", requires_auth: true, audit: "executive" }),
  create_crm_lead: T("HOUSE", "Create a prospect in a CRM. No CRM is connected.", { source_type: "external_action", requires_auth: true, audit: "executive" }),
  issue_refund: T("FINANCE", "Refund a client.", { source_type: "external_action", requires_auth: true, audit: "executive", idempotent: false }),
  vendor_payment: T("FINANCE", "Pay a vendor.", { source_type: "external_action", requires_auth: true, audit: "executive", idempotent: false }),
  change_project_price: T("FINANCE", "Change a commission's price.", { audit: "executive" }),
  approve_rush_request: T("HOUSE", "Approve a rush.", { audit: "executive" }),
  production_change: T("HOUSE", "Change production.", { audit: "executive" }),
  deploy_production: T("ENGINEERING", "Deploy to production.", { audit: "executive" }),
  change_policy: T("HOUSE", "Change a House policy.", { audit: "executive" }),
  delete_financial_record: T("FINANCE", "Never permitted."),
  delete_client_record: T("HOUSE", "Never permitted."),
  move_money_autonomously: T("FINANCE", "Never permitted."),
};

const RISK = { [P.READ]: "LOW", [P.ANALYZE]: "LOW", [P.DRAFT]: "LOW", [P.INTERNAL_WRITE]: "MEDIUM", [P.APPROVAL_REQUIRED]: "HIGH", [P.PROHIBITED]: "PROHIBITED" };

/* Tools that run inside another tool's pipeline rather than on their own. */
const VIA = { x_search: "web_search", email_verify: "email_find" };

/* The catalogue, with live configuration.  `configured` maps tool id to
   true/false (or a status string) from the running server; `implemented`
   is the set of tools that have code behind the gate; `executors` the set
   of approval-class tools that have a connected executor.  Nothing is shown
   as AVAILABLE unless code exists to run it. */
export function toolCatalog(configured = {}, { implemented = null, executors = null } = {}) {
  return Object.entries(TOOL_POLICY).map(([id, pol]) => {
    const m = TOOL_META[id] || T("UNKNOWN", "");
    const c = configured[id];
    let status;
    if (pol.cls === P.PROHIBITED) status = "PROHIBITED";
    else if (pol.cls === P.APPROVAL_REQUIRED) status = c === true || c === "CONNECTED" ? "CONNECTED" : executors && executors.has(id) && c === undefined ? "CONNECTED" : "APPROVAL_ONLY";
    else if (c !== undefined) status = c === true ? "CONNECTED" : c === false ? "NOT_CONFIGURED" : c;
    else status = !implemented || implemented.has(id) ? "AVAILABLE" : "NOT_IMPLEMENTED";
    return { id, name: id.replace(/_/g, " "), description: m.description, category: m.category, permission_level: pol.cls, reversibility: pol.rev,
      risk_level: RISK[pol.cls], external: !!pol.external, money: !!pol.money, cost_hint: m.cost, latency_hint: m.latency, source_type: m.source_type,
      requires_auth: m.requires_auth, supports_idempotency: m.idempotent, audit_behavior: m.audit, runs_inside: VIA[id] || null,
      configured: status === "CONNECTED" || status === "AVAILABLE", status,
      status_note: status === "APPROVAL_ONLY" ? "Can be approved; nothing is connected to carry it out, so a person does it." : status === "NOT_IMPLEMENTED" ? "Declared with its permission class; no code runs it yet." : null };
  });
}
