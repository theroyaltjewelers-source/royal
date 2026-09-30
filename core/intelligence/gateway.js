/* The Integration Gateway: one predictable contract between ROYAL and every
   application it works with.

     ROYAL -> tool (permission-checked) -> gateway -> adapter -> system

   Every adapter declares what it exposes: ENTITIES, READ actions, WRITE
   actions and EVENTS, plus its live status.  Reads go through the adapter;
   writes are listed so the permission engine and the planner know they
   exist, and they are only ever reached through the ConsequenceGate.

   MCP: none of the House's systems exposes an MCP server today, and ROYAL's
   own tools are called in-process, so MCP would add a hop without adding
   anything.  An MCP adapter can be registered here like any other when a
   system offers one. */

export class IntegrationGateway {
  constructor() { this.adapters = new Map(); }
  register(a) {
    for (const f of ["id", "system", "entities", "reads", "writes", "events", "status"]) if (a[f] === undefined) throw new Error("ADAPTER_INVALID: " + (a.id || "?") + " missing " + f);
    this.adapters.set(a.id, a); return a;
  }
  get(id) { return this.adapters.get(id) || null; }
  async describe() {
    const out = [];
    for (const a of this.adapters.values()) out.push({ id: a.id, system: a.system, entities: a.entities, reads: a.reads, writes: a.writes, events: a.events, transport: a.transport || "internal", status: await a.status() });
    return out;
  }
  async read(id, action, args = {}) {
    const a = this.get(id);
    if (!a) return { ok: false, failed_because: "UNKNOWN_ADAPTER" };
    if (a.reads.indexOf(action) < 0 || !a.read) return { ok: false, failed_because: "UNKNOWN_READ" };
    const st = await a.status();
    if (st.status !== "CONNECTED") return { ok: false, failed_because: "NOT_CONNECTED", detail: st.detail || null };
    return a.read(action, args);
  }
}

/* The adapters ROYAL has today. */
export function defaultGateway({ connector, tools, clock = () => Date.now(), email = null, bridge = null, research = null, contacts = null }) {
  const g = new IntegrationGateway();
  g.register({
    id: "calculator", system: "Royal T Project Calculator", transport: "House API rtj.house.v1 (pushed snapshots)",
    entities: ["Client", "Project", "Payment", "Vendor", "ProductionStage", "Commitment", "Treasury"],
    reads: ["get_active_projects", "get_project", "get_client", "get_production_status", "get_outstanding_balances", "get_expected_payments", "get_treasury", "get_upcoming_deadlines", "get_sales_pipeline"],
    writes: [], events: ["PAYMENT_RECEIVED", "PAYMENT_OVERDUE", "PRODUCTION_STAGE_CHANGED", "PROJECT_READY", "SNAPSHOT_INGESTED"],
    status: async () => { const s = await connector.status(clock()); return { status: s.connected ? "CONNECTED" : "NOT_CONNECTED", detail: s.connected ? s.age : "The calculator has not sent its state." }; },
    read: async (action, args) => (tools.get(action) ? tools.get(action)(args) : { ok: false, failed_because: "UNKNOWN_READ" }),
  });
  g.register({ id: "research", system: "Public web (through the model provider's search)", entities: ["Company", "Person", "ResearchClaim", "ResearchSource"],
    reads: ["web_search", "web_fetch", "company_search", "person_search"], writes: [], events: [],
    status: async () => (research ? research.status() : { status: "NOT_CONFIGURED" }) });
  g.register({ id: "contacts", system: "Professional contact providers (Hunter, Apollo)", entities: ["ProfessionalContact", "ContactVerification"],
    reads: ["email_find", "email_verify"], writes: [], events: [],
    status: async () => { if (!contacts) return { status: "NOT_CONFIGURED" }; const s = contacts.status(); return { status: s.discovery, detail: "verification: " + s.verification.toLowerCase() }; } });
  g.register({ id: "email", system: "Outbound email (Resend)", entities: ["Message"], reads: [], writes: ["send_email"], events: ["MESSAGE_SENT", "MESSAGE_FAILED"],
    status: async () => (email ? email.status() : { status: "NOT_CONFIGURED", detail: "RESEND_API_KEY and ROYAL_EMAIL_FROM are not set." }) });
  g.register({ id: "grokbots", system: "External Grok Bots (bridge)", entities: ["BotRequest", "BotEvent"], reads: [], writes: ["delegate_to_bot"], events: ["BOT_EVENT"],
    status: async () => (!bridge ? { status: "NOT_CONNECTED" } : bridge.enabled && !bridge.enabled() ? { status: "DISABLED", detail: "GROKBOT_ENABLED is not true." }
      : { status: "CONNECTED", detail: "storage " + bridge.storage().toLowerCase() }) });
  for (const [id, system, entities] of [["crm", "CRM", ["Lead", "Contact", "Activity"]], ["calendar", "Calendar", ["Appointment"]], ["gold_buy", "Gold Buy", ["Purchase", "Quote"]],
    ["quickbooks", "QuickBooks", ["Invoice", "Payment"]], ["jewel360", "Jewel360", ["Client", "Sale"]], ["instagram", "Instagram / Meta", ["Post", "Message"]]])
    g.register({ id, system, entities, reads: [], writes: [], events: [], status: async () => ({ status: "NOT_CONNECTED", detail: "No adapter yet." }) });
  return g;
}
