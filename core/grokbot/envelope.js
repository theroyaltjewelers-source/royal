/* The structured reply a Grok Bot sends back for work ROYAL gave it.

   A bot may write prose for the feed, but orchestration reads only this
   envelope.  It arrives as the `envelope` field of the bot's event, or as a
   JSON block in its content_markdown.  It is data: nothing in it can choose
   a tool, a recipient or an action.

     {
       "agent_id": "grace", "task_id": "...", "handoff_id": "...",
       "status": "REPORTED_COMPLETE" | "PARTIAL" | "FAILED" | "WAITING" | "IN_PROGRESS",
       "summary": "...", "findings": [], "sources": [], "actions_taken": [],
       "artifacts": [], "next_actions": [], "requires_tahir": false,
       "requires_approval": false, "unresolved_questions": [],
       "requested_specialist": null, "requested_reason": null,
       "nonce": "...", "name": "...", "role": "...", "timestamp": "..."
     }

   The message ROYAL sends carries `handoff_id:` and, for a connection test,
   `nonce:` lines; a reply verifies only if it repeats them exactly and names
   the bot it came from. */

export const ENVELOPE_STATUSES = ["REPORTED_COMPLETE", "PARTIAL", "FAILED", "WAITING", "IN_PROGRESS"];
const AGENT_IDS = ["ace", "grace", "ledger", "house", "forge"];
const LISTS = ["findings", "sources", "actions_taken", "artifacts", "next_actions", "unresolved_questions"];
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);

/* The envelope, from an event body, or null when there is none. */
export function envelopeFrom(body) {
  if (!isObj(body)) return null;
  if (isObj(body.envelope)) return body.envelope;
  const text = typeof body.content_markdown === "string" ? body.content_markdown.trim() : "";
  if (!text) return null;
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/i.exec(text);
  const raw = fenced ? fenced[1] : text.startsWith("{") ? text : null;
  if (!raw) return null;
  try { const j = JSON.parse(raw); return isObj(j) ? j : null; } catch (_) { return null; }
}

/* What ROYAL's own message asked to be repeated back. */
export function expectedFrom(requestContent) {
  const c = String(requestContent || "");
  const h = /^handoff_id:\s*([A-Za-z0-9_-]{6,64})\s*$/m.exec(c), n = /^nonce:\s*([A-Za-z0-9_-]{6,64})\s*$/m.exec(c), t = /^task_id:\s*([A-Za-z0-9_-]{4,64})\s*$/m.exec(c);
  return { handoff_id: h ? h[1] : null, nonce: n ? n[1] : null, task_id: t ? t[1] : null };
}

/* Checks an envelope against the bot it came from and what was asked.
   Returns { ok, errors, envelope } with the envelope trimmed to its shape. */
export function validateEnvelope(env, { bot_id, handoff_id = null, nonce = null } = {}) {
  const errors = [];
  if (!isObj(env)) return { ok: false, errors: ["no structured envelope"], envelope: null };
  if (env.agent_id !== bot_id) errors.push("agent_id must be " + bot_id);
  if (handoff_id && env.handoff_id !== handoff_id) errors.push("handoff_id does not match the handoff");
  if (nonce && env.nonce !== nonce) errors.push("nonce does not match");
  if (ENVELOPE_STATUSES.indexOf(env.status) < 0) errors.push("status must be one of " + ENVELOPE_STATUSES.join(", "));
  if (typeof env.summary !== "string" || !env.summary.trim()) errors.push("summary is required");
  for (const k of LISTS) if (env[k] !== undefined && !Array.isArray(env[k])) errors.push(k + " must be a list");
  for (const k of ["requires_tahir", "requires_approval"]) if (env[k] !== undefined && typeof env[k] !== "boolean") errors.push(k + " must be true or false");
  if (env.requested_specialist != null && AGENT_IDS.indexOf(env.requested_specialist) < 0) errors.push("requested_specialist is not a specialist");
  /* A list entry: text, or a small object; anything larger becomes text. */
  const safeItem = (x) => {
    if (typeof x === "string") return x.slice(0, 600);
    if (!isObj(x)) return null;
    let j; try { j = JSON.stringify(x); } catch (_) { return null; }
    return j.length <= 2000 ? JSON.parse(j) : j.slice(0, 600);
  };
  const clean = {
    agent_id: str(env.agent_id, 32), task_id: str(env.task_id, 64), handoff_id: str(env.handoff_id, 64), status: env.status,
    summary: str(env.summary, 4000), requires_tahir: env.requires_tahir === true, requires_approval: env.requires_approval === true,
    requested_specialist: AGENT_IDS.indexOf(env.requested_specialist) >= 0 ? env.requested_specialist : null, requested_reason: str(env.requested_reason, 400),
    nonce: str(env.nonce, 64), name: str(env.name, 80), role: str(env.role, 160), timestamp: str(env.timestamp, 40),
  };
  for (const k of LISTS) clean[k] = Array.isArray(env[k]) ? env[k].slice(0, 50).map(safeItem).filter((x) => x != null) : [];
  return { ok: !errors.length, errors, envelope: clean };
}

/* The reply instructions every ROYAL message to a bot ends with. */
export function replyInstructions({ bot_id, task_id, handoff_id, nonce = null }) {
  return [
    "Reply by posting ONE event of type \"result\" to your reply endpoint, with the request_id from this message.",
    "Put this JSON in a ```json block in content_markdown (or send it as the \"envelope\" field). It is required; prose alone is not accepted as a result.",
    "```json",
    JSON.stringify({ agent_id: bot_id, task_id, handoff_id, ...(nonce ? { nonce, name: "<your name>", role: "<your role>" } : {}),
      status: "REPORTED_COMPLETE | PARTIAL | FAILED | WAITING", summary: "<what you found, plainly>", findings: [], sources: [], actions_taken: [], artifacts: [],
      next_actions: [], requires_tahir: false, requires_approval: false, unresolved_questions: [], requested_specialist: null, requested_reason: null, timestamp: "<ISO time>" }),
    "```",
    "If you need another specialist (ace, grace, ledger, house, forge), name it in requested_specialist; do not contact it yourself. ROYAL decides.",
    "Take no external action: do not send messages, move money, change prices, change production, publish, delete or deploy. Propose those in next_actions; Tahir approves them through ROYAL.",
  ].join("\n");
}
