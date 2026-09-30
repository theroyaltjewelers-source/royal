/* Who exists in ROYAL, and what each of them is.

   Two registries:
     Realms and their domains: the parts of Tahir's world ROYAL can know about.
     Agents: the intelligences that reason over those domains.

   Adding an agent or a domain is a registration, not a rewrite.  Nothing
   outside this file needs to change for a new specialist to exist; routing
   and permissions read from here. */

import { REALM, CONNECTION } from "./enums.js";
import { deepFreeze } from "./util.js";

/* ---------------------------------------------------------------- realms -- */

export const DOMAINS = deepFreeze([
  { id: "royal_t", realm: REALM.BUSINESS, name: "The House of Royal T",
    description: "Bespoke fine jewelry, custom grillz and diamond-set timepieces.",
    connector: "calculator", status: CONNECTION.NOT_CONNECTED },
  { id: "tahir_and_co", realm: REALM.BUSINESS, name: "Tahir & Co.",
    description: "Separate fine jewelry brand. Separate entity, separate records.",
    connector: null, status: CONNECTION.NOT_CONNECTED },
  { id: "gold_buy", realm: REALM.BUSINESS, name: "Gold Buy",
    description: "Business line not yet described to ROYAL.",
    connector: null, status: CONNECTION.NOT_CONNECTED },
  { id: "operations", realm: REALM.BUSINESS, name: "Operations",
    description: "Cross-business operations: staff, systems, vendors shared between lines.",
    connector: null, status: CONNECTION.NOT_CONNECTED },
  { id: "wealth", realm: REALM.PERSONAL, name: "Tahir Wealth",
    description: "Personal finances and holdings.", connector: null, status: CONNECTION.NOT_CONNECTED },
  { id: "calendar", realm: REALM.PERSONAL, name: "Calendar",
    description: "Tahir's schedule.", connector: null, status: CONNECTION.NOT_CONNECTED },
  { id: "personal_tasks", realm: REALM.PERSONAL, name: "Personal tasks",
    description: "Tahir's own to-do items.", connector: null, status: CONNECTION.NOT_CONNECTED },
]);

export function domainById(id) { return DOMAINS.find((d) => d.id === id) || null; }
export function realmOf(domainId) { const d = domainById(domainId); return d ? d.realm : null; }

/* ---------------------------------------------------------------- agents -- */

/* Fields per the agent contract:
   id, name, role, description, capabilities, allowed_tools, permission_profile,
   knowledge_sources, escalation_target, status, version, plus realms and
   domains, which bound what the agent may ever see. */
const AGENTS_V1 = [
  {
    id: "royal", name: "ROYAL", role: "Orchestrator and executive intelligence",
    description: "The one intelligence Tahir talks to. Routes, verifies, synthesises and gates.",
    realms: [REALM.BUSINESS, REALM.PERSONAL], domains: ["*"],
    capabilities: ["route", "delegate", "synthesise", "brief", "triage", "request_approval"],
    allowed_tools: ["*read", "*analyze", "*draft", "request_approval", "create_internal_task", "record_commitment", "record_waiting",
      /* requestable only: each of these becomes a decision for Tahir */
      "send_client_message", "issue_refund", "vendor_payment", "change_project_price", "approve_rush_request", "production_change", "change_policy"],
    permission_profile: "royal_v1", knowledge_sources: ["docs/agents/ROYAL_CONSTITUTION.md", "docs/company/HOUSE_POLICY_MANUAL.md"],
    escalation_target: "tahir", status: "ACTIVE", version: "0.1.0",
  },
  {
    id: "ace", name: "ACE", role: "Sales and CRM intelligence",
    description: "Inquiries, qualification, consultations, follow-up, deposits, stalled leads, handoff to GRACE.",
    realms: [REALM.BUSINESS], domains: ["royal_t", "tahir_and_co"],
    capabilities: ["pipeline", "lead_followup", "qualification", "handoff"],
    allowed_tools: ["get_sales_pipeline", "get_active_projects", "get_project", "get_client", "draft_client_update", "request_approval", "send_client_message"],
    permission_profile: "specialist_v1", knowledge_sources: ["docs/agents/ACE_CONSTITUTION.md"],
    escalation_target: "royal", status: "ACTIVE", version: "0.1.0",
  },
  {
    id: "grace", name: "GRACE", role: "Client experience and production intelligence",
    description: "Design, CAD, approvals, production, vendors, QC, client updates, pickup, aftercare.",
    realms: [REALM.BUSINESS], domains: ["royal_t", "tahir_and_co"],
    capabilities: ["production", "client_updates", "pickup", "qc"],
    allowed_tools: ["get_active_projects", "get_project", "get_client", "get_production_status", "get_waiting_items",
      "get_open_commitments", "get_upcoming_deadlines", "draft_client_update", "request_approval", "send_client_message", "production_change"],
    permission_profile: "specialist_v1", knowledge_sources: ["docs/agents/GRACE_CONSTITUTION.md"],
    escalation_target: "royal", status: "ACTIVE", version: "0.1.0",
  },
  {
    id: "ledger", name: "LEDGER", role: "Finance and profitability intelligence",
    description: "Receivables, expected payments, collected cash, vendor obligations, margins, cash position.",
    realms: [REALM.BUSINESS], domains: ["royal_t", "tahir_and_co", "gold_buy"],
    capabilities: ["receivables", "cash", "margins", "leakage"],
    allowed_tools: ["get_active_projects", "get_project", "get_outstanding_balances", "get_expected_payments", "get_treasury", "request_approval", "send_client_message", "issue_refund", "vendor_payment"],
    permission_profile: "specialist_v1", knowledge_sources: ["docs/agents/LEDGER_CONSTITUTION.md"],
    escalation_target: "royal", status: "ACTIVE", version: "0.1.0",
  },
  {
    id: "house", name: "HOUSE", role: "Brand and marketing intelligence",
    description: "Content, campaigns, social presence and brand standards. Registered; not yet connected to any system.",
    realms: [REALM.BUSINESS], domains: ["royal_t", "tahir_and_co"],
    capabilities: ["content", "campaigns", "brand_standards"],
    allowed_tools: [],
    permission_profile: "specialist_v1", knowledge_sources: ["docs/company/HOUSE_COMPANY_BIBLE.md"],
    escalation_target: "royal", status: "NOT_CONNECTED", version: "0.1.0",
  },
  {
    id: "forge", name: "FORGE", role: "Engineering and systems intelligence",
    description: "Integrations, connectors, data integrity, automation health, incidents, AI infrastructure.",
    realms: [REALM.BUSINESS], domains: ["*"],
    capabilities: ["connector_health", "data_integrity", "incidents"],
    allowed_tools: ["get_system_status", "get_recent_activity", "request_approval", "deploy_production"],
    permission_profile: "specialist_v1", knowledge_sources: ["docs/agents/FORGE_CONSTITUTION.md"],
    escalation_target: "royal", status: "ACTIVE", version: "0.1.0",
  },
];

export class AgentRegistry {
  constructor(agents = AGENTS_V1) {
    this.byId = new Map();
    agents.forEach((a) => this.register(a));
  }
  register(a) {
    for (const f of ["id", "name", "role", "realms", "domains", "allowed_tools", "permission_profile", "escalation_target", "status", "version"])
      if (a[f] === undefined) throw new Error("AGENT_INVALID: " + (a.id || "?") + " is missing " + f);
    if (this.byId.has(a.id)) throw new Error("AGENT_DUPLICATE: " + a.id);
    this.byId.set(a.id, deepFreeze(JSON.parse(JSON.stringify(a))));
    return this.byId.get(a.id);
  }
  get(id) { return this.byId.get(id) || null; }
  all() { return Array.from(this.byId.values()); }
  specialists() { return this.all().filter((a) => a.id !== "royal"); }

  /* Whether an agent's charter covers a domain at all.  This is the realm
     wall: a business specialist asking about Tahir's personal calendar is
     refused here before any tool is looked up. */
  covers(agentId, domainId) {
    const a = this.get(agentId), d = domainById(domainId);
    if (!a || !d) return false;
    if (a.realms.indexOf(d.realm) < 0) return false;
    return a.domains.indexOf("*") >= 0 || a.domains.indexOf(domainId) >= 0;
  }
}
