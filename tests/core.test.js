import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "../core/registry.js";
import { PermissionService, TOOL_POLICY } from "../core/permissions.js";
import { MemoryStore } from "../core/store.js";
import { AuditService } from "../core/audit.js";
import { DecisionService, ConsequenceGate } from "../core/decisions.js";
import { EventBus } from "../core/events.js";
import { route } from "../core/router.js";
import { resolveEntity } from "../core/context.js";
import { freshness, sourceConflict, fact } from "../core/sources.js";
import { validateResult, agentResult } from "../core/result.js";
import { redact } from "../core/util.js";
import { validateSnapshot } from "../realms/business/royal-t/contract.js";
import { house, NOW } from "./fixtures.js";

const OWNER = { id: "u-tahir", role: "owner" };

function rig(flags) {
  const store = new MemoryStore(), audit = new AuditService(store, () => NOW);
  const registry = new AgentRegistry(), permissions = new PermissionService(registry, flags);
  const decisions = new DecisionService({ store, audit, clock: () => NOW });
  const tools = new Map([["get_project", async () => ({ ok: true, data: { id: "x" } })], ["create_internal_task", async () => ({ ok: true })]]);
  const gate = new ConsequenceGate({ permissions, decisions, audit, tools });
  return { store, audit, registry, permissions, decisions, gate, tools };
}

/* ------------------------------------------------------------ permission -- */
test("reads are allowed for an agent whose charter lists them", () => {
  const { permissions } = rig();
  assert.equal(permissions.check({ agentId: "grace", tool: "get_project", domain: "royal_t" }).allowed, true);
});
test("an agent is refused a tool outside its charter", () => {
  const { permissions } = rig();
  const v = permissions.check({ agentId: "ace", tool: "get_treasury", domain: "royal_t" });
  assert.equal(v.allowed, false); assert.equal(v.reason, "TOOL_NOT_IN_CHARTER");
});
test("prohibited tools are refused to everyone, ROYAL included", () => {
  const { permissions } = rig();
  for (const a of ["royal", "ledger", "forge"]) {
    const v = permissions.check({ agentId: a, tool: "delete_financial_record" });
    assert.equal(v.allowed, false); assert.equal(v.requiresApproval, false); assert.equal(v.reason, "PROHIBITED");
  }
});
test("unknown tools and unknown agents are refused", () => {
  const { permissions } = rig();
  assert.equal(permissions.check({ agentId: "royal", tool: "rm_rf" }).reason, "UNKNOWN_TOOL");
  assert.equal(permissions.check({ agentId: "mallory", tool: "get_project" }).reason, "UNKNOWN_AGENT");
});
test("sending a client message always requires approval", () => {
  const { permissions } = rig({ agent_external_send: true, agent_internal_write: true });
  const v = permissions.check({ agentId: "royal", tool: "send_client_message", domain: "royal_t" });
  assert.equal(v.allowed, false); assert.equal(v.requiresApproval, true);
});
test("internal writes need approval while the flag is off, and run when it is on", () => {
  assert.equal(rig().permissions.check({ agentId: "royal", tool: "create_internal_task", domain: "royal_t" }).requiresApproval, true);
  assert.equal(rig({ agent_internal_write: true }).permissions.check({ agentId: "royal", tool: "create_internal_task", domain: "royal_t" }).allowed, true);
});
test("the realm wall: a business specialist cannot read the personal realm", () => {
  const { permissions } = rig();
  const v = permissions.check({ agentId: "ledger", tool: "get_treasury", domain: "wealth" });
  assert.equal(v.allowed, false); assert.equal(v.reason, "REALM_BOUNDARY");
  assert.equal(permissions.check({ agentId: "grace", tool: "get_project", domain: "calendar" }).reason, "REALM_BOUNDARY");
});
test("every tool in the policy has a class and a reversibility", () => {
  for (const [k, v] of Object.entries(TOOL_POLICY)) { assert.ok(v.cls, k); assert.ok(v.rev, k); }
});
test("a registered agent must be complete and unique", () => {
  const r = new AgentRegistry();
  assert.throws(() => r.register({ id: "x" }), /AGENT_INVALID/);
  assert.throws(() => r.register({ ...r.get("ace") }), /AGENT_DUPLICATE/);
  const n = r.register({ id: "vault", name: "VAULT", role: "Personal wealth", realms: ["PERSONAL"], domains: ["wealth"], allowed_tools: ["*read"],
    permission_profile: "specialist_v1", escalation_target: "royal", status: "ACTIVE", version: "0.1.0" });
  assert.equal(r.covers("vault", "wealth"), true); assert.equal(r.covers("vault", "royal_t"), false); assert.ok(n);
});

/* ---------------------------------------------------------------- gate -- */
test("the gate executes an allowed read and audits it", async () => {
  const { gate, audit } = rig();
  const r = await gate.request({ agentId: "grace", tool: "get_project", args: { id: "x" }, domain: "royal_t" });
  assert.equal(r.status, "OK");
  assert.ok((await audit.developerLog()).some((e) => e.action === "TOOL_CALLED" && e.tool === "get_project"));
});
test("an unauthorised request is denied and recorded, not executed", async () => {
  const { gate, audit, tools } = rig();
  let ran = false; tools.set("delete_financial_record", async () => { ran = true; });
  const r = await gate.request({ agentId: "ledger", tool: "delete_financial_record", args: {} });
  assert.equal(r.status, "DENIED"); assert.equal(ran, false);
  assert.ok((await audit.developerLog()).some((e) => e.action === "PERMISSION_DENIED"));
});
test("a failed tool is reported as a failure with its impact, never as success", async () => {
  const { gate, tools } = rig();
  tools.set("get_project", async () => { throw new Error("adapter down"); });
  const r = await gate.request({ agentId: "grace", tool: "get_project", domain: "royal_t" });
  assert.equal(r.status, "FAILED"); assert.equal(r.result, "FAILED"); assert.match(r.failed_because, /adapter down/); assert.ok(r.impact);
});
test("a tool that is allowed but not connected fails honestly", async () => {
  const { gate } = rig();
  const r = await gate.request({ agentId: "grace", tool: "get_client", domain: "royal_t" });
  assert.equal(r.status, "FAILED"); assert.equal(r.failed_because, "TOOL_NOT_CONNECTED");
});

/* ----------------------------------------------------------- decisions -- */
test("an approval-class request becomes one decision, however often it is asked", async () => {
  const { gate, decisions } = rig();
  const a = await gate.request({ agentId: "royal", tool: "send_client_message", args: { body: "hi" }, domain: "royal_t", decision: { title: "Send update", dedupe_key: "k1" } });
  const b = await gate.request({ agentId: "royal", tool: "send_client_message", args: { body: "hi" }, domain: "royal_t", decision: { title: "Send update", dedupe_key: "k1" } });
  assert.equal(a.status, "PENDING_APPROVAL"); assert.equal(a.created, true); assert.equal(b.created, false);
  assert.equal((await decisions.list({ status: "OPEN" })).length, 1);
});
test("only an owner can resolve a decision; silence resolves nothing", async () => {
  const { decisions } = rig();
  const { decision } = await decisions.create({ type: "REFUND", title: "Refund", requested_by_agent: "ledger", action: { tool: "issue_refund", args: {} } });
  const r = await decisions.resolve(decision.id, { actor: { id: "u-staff", role: "staff" }, resolution: "APPROVE" });
  assert.equal(r.ok, false); assert.equal(r.failed_because, "ONLY_OWNER_MAY_RESOLVE");
  assert.equal((await decisions.get(decision.id)).status, "OPEN");
});
test("a rejected decision executes nothing", async () => {
  const { decisions } = rig(); let ran = false;
  decisions.registerExecutor("issue_refund", async () => { ran = true; return { ok: true }; });
  const { decision } = await decisions.create({ type: "REFUND", title: "Refund", requested_by_agent: "ledger", action: { tool: "issue_refund", args: { amount: 100 } } });
  const r = await decisions.resolve(decision.id, { actor: OWNER, resolution: "REJECT" });
  assert.equal(r.decision.status, "REJECTED"); assert.equal(ran, false);
});
test("a modified approval executes with the modified arguments", async () => {
  const { decisions } = rig(); let got;
  decisions.registerExecutor("issue_refund", async (args) => { got = args; return { ok: true, verify: async () => true }; });
  const { decision } = await decisions.create({ type: "REFUND", title: "Refund", requested_by_agent: "ledger", action: { tool: "issue_refund", args: { amount: 500 } } });
  const r = await decisions.resolve(decision.id, { actor: OWNER, resolution: "MODIFY", modified_args: { amount: 250 } });
  assert.equal(got.amount, 250); assert.equal(r.decision.status, "VERIFIED");
});
test("an execution failure is recorded as FAILED, not as done", async () => {
  const { decisions } = rig();
  decisions.registerExecutor("vendor_payment", async () => { throw new Error("bank refused"); });
  const { decision } = await decisions.create({ type: "VENDOR_PAYMENT", title: "Pay vendor", requested_by_agent: "ledger", action: { tool: "vendor_payment", args: {} } });
  const r = await decisions.resolve(decision.id, { actor: OWNER, resolution: "APPROVE" });
  assert.equal(r.ok, false); assert.equal(r.decision.status, "FAILED"); assert.match(r.execution.failed_because, /bank refused/);
});
test("a verification failure is caught even when the executor says ok", async () => {
  const { decisions } = rig();
  decisions.registerExecutor("create_internal_task", async () => ({ ok: true, verify: async () => false }));
  const { decision } = await decisions.create({ type: "INTERNAL_ACTION", title: "Task", requested_by_agent: "royal", action: { tool: "create_internal_task", args: { title: "x" } } });
  const r = await decisions.resolve(decision.id, { actor: OWNER, resolution: "APPROVE" });
  assert.equal(r.ok, false); assert.equal(r.decision.status, "FAILED");
});
test("an approved action with no executor says a person must do it", async () => {
  const { decisions } = rig();
  const { decision } = await decisions.create({ type: "SEND_CLIENT_MESSAGE", title: "Send", requested_by_agent: "royal", action: { tool: "send_client_message", args: {} } });
  const r = await decisions.resolve(decision.id, { actor: OWNER, resolution: "APPROVE" });
  assert.equal(r.execution.result, "NO_EXECUTOR"); assert.equal(r.decision.status, "APPROVED");
});
test("a decision cannot be resolved twice", async () => {
  const { decisions } = rig();
  const { decision } = await decisions.create({ type: "GENERAL", title: "x", requested_by_agent: "royal" });
  await decisions.resolve(decision.id, { actor: OWNER, resolution: "REJECT" });
  const r = await decisions.resolve(decision.id, { actor: OWNER, resolution: "APPROVE" });
  assert.equal(r.ok, false); assert.equal(r.failed_because, "ALREADY_REJECTED");
});

/* --------------------------------------------------------------- store -- */
test("store refuses a write over a revision that has moved", async () => {
  const s = new MemoryStore();
  const a = await s.put("tasks", "t1", { v: 1 }, null);
  assert.equal(a.ok, true);
  assert.equal((await s.put("tasks", "t1", { v: 2 }, null)).ok, false);
  assert.equal((await s.put("tasks", "t1", { v: 2 }, 1)).ok, true);
  const stale = await s.put("tasks", "t1", { v: 3 }, 1);
  assert.equal(stale.ok, false); assert.equal(stale.current.data.v, 2);
});
test("the audit log is append-only", async () => {
  const s = new MemoryStore();
  await s.append("audit", { action: "X" });
  await assert.rejects(() => s.put("audit", "audit_00000001", {}, 1), /APPEND_ONLY/);
  const [r] = await s.readLog("audit");
  assert.throws(() => { "use strict"; r.action = "Y"; s.logs.get("audit")[0].action = "Y"; });
});

/* ------------------------------------------------------------ security -- */
test("secrets never reach the audit log", async () => {
  const s = new MemoryStore(), a = new AuditService(s);
  await a.record({ action: "X", result: { api_key: "xai-abcdefghijklmnopqrstu", nested: { Authorization: "Bearer y" }, jwt: "eyJa.eyJb.c" } });
  const [r] = await s.readLog("audit");
  const txt = JSON.stringify(r);
  assert.ok(!/xai-abc/.test(txt)); assert.ok(!/Bearer y/.test(txt)); assert.ok(!/eyJa\.eyJb/.test(txt));
});
test("redact catches bare keys and tokens in values", () => {
  assert.equal(redact("xai-0123456789abcdefghij"), "[REDACTED_KEY]");
  assert.equal(redact("eyJhbGciOi.eyJzdWIi.sig"), "[REDACTED_JWT]");
});
test("a snapshot carrying a forbidden field is rejected", () => {
  const s = house(); s.projects[0].client.address = "1 Main St";
  const v = validateSnapshot(s);
  assert.equal(v.ok, false); assert.ok(v.errors.some((e) => /forbidden field/.test(e)));
});
test("a snapshot with an unknown contract or stage is rejected", () => {
  assert.equal(validateSnapshot({ ...house(), contract: "rtj.house.v9" }).ok, false);
  const s = house(); s.projects[0].stage = "Teleported";
  assert.equal(validateSnapshot(s).ok, false);
  assert.equal(validateSnapshot(house()).ok, true);
});

/* ------------------------------------------------------------- events -- */
test("a duplicate event is recognised and handled once", async () => {
  const s = new MemoryStore(), bus = new EventBus({ store: s, audit: new AuditService(s) });
  let n = 0; bus.subscribe(["PAYMENT_RECEIVED"], () => { n++; });
  await bus.publish({ type: "PAYMENT_RECEIVED", key: "p1" });
  const again = await bus.publish({ type: "PAYMENT_RECEIVED", key: "p1" });
  assert.equal(n, 1); assert.equal(again.duplicate, true);
  await assert.rejects(() => bus.publish({ type: "NOT_A_THING", key: "x" }), /EVENT_INVALID/);
});

/* ----------------------------------------------------- routing/context -- */
test("routing places the flagship questions", () => {
  const cases = { "What needs me?": "what_needs_me", "ROYAL, can I step away for the rest of the day?": "can_i_step_away",
    "State of the House": "state_of_house", "Who owes us money?": "who_owes_us", "What are we waiting on?": "waiting_for",
    "Which promises are due?": "commitments", "What's happening with production?": "production_status", "What changed today?": "what_changed",
    "What needs my approval?": "decisions_open", "Get me ready for tomorrow.": "morning_briefing", "Show me revenue leakage.": "revenue_leakage",
    "Handle it.": "handle_it", "What's on my calendar tomorrow?": "personal", "How is Tahir & Co doing?": "other_business",
    "Which clients are at risk?": "clients_at_risk" };
  for (const [q, s] of Object.entries(cases)) assert.equal(route(q).skill, s, q);
  assert.equal(route("What's the status of Marcus's project?", { entityResolved: true }).skill, "project_status");
  assert.equal(route("Compose a haiku about gold").skill, "open_question");
});
test("names resolve to one record, or to a question when two match", () => {
  const ps = house().projects;
  assert.equal(resolveEntity("status of Marcus's project", { projects: ps }).entity.id, "PRJ-2026-00101");
  const amb = resolveEntity("What about Johnson?", { projects: ps });
  assert.equal(amb.status, "AMBIGUOUS"); assert.equal(amb.candidates.length, 2);
  assert.equal(resolveEntity("Why hasn't the Johnson pendant moved?", { projects: ps }).entity.id, "PRJ-2026-00102");
  assert.equal(resolveEntity("how is PRJ-2026-00105", { projects: ps }).entity.id, "PRJ-2026-00105");
  assert.equal(resolveEntity("PRJ-2026-99999", { projects: ps }).status, "NOT_FOUND");
  assert.equal(resolveEntity("what about his project?", { projects: ps, recent: { id: "PRJ-2026-00104" } }).entity.id, "PRJ-2026-00104");
});

/* ------------------------------------------------- evidence/freshness -- */
test("freshness distinguishes current, recent, stale and unknown", () => {
  assert.equal(freshness("PROJECT_STATUS", NOW - 60000, NOW), "CURRENT");
  assert.equal(freshness("PROJECT_STATUS", NOW - 3 * 3600000, NOW), "RECENT");
  assert.equal(freshness("PROJECT_STATUS", NOW - 30 * 3600000, NOW), "STALE");
  assert.equal(freshness("PROJECT_STATUS", null, NOW), "UNKNOWN");
});
test("conflicting sources are reported with both values, not resolved", () => {
  const c = sourceConflict("CLIENT", "CL-1", fact("a@x.com", { source: "calculator" }), fact("b@x.com", { source: "jewel360" }));
  assert.equal(c.kind, "SOURCE_CONFLICT"); assert.equal(c.values.length, 2);
});
test("a result claiming VERIFIED with no source is invalid", () => {
  const r = agentResult({ agent: "grace", run_id: "r", findings: [{ title: "x", priority: "P2", risk: "YELLOW", need: "KNOW", evidence: { label: "VERIFIED" } }] });
  assert.equal(validateResult(r).ok, false);
});
