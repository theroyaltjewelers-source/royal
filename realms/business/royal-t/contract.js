/* The House API contract: what the Royal T Project Calculator gives ROYAL.

   The calculator stays authoritative.  Every derived figure in this contract
   (value, paid, health, next action, runway) is computed inside the
   calculator by its own canonical functions and shipped here as a result.
   ROYAL never re-derives them, because the calculator's pricing and
   enhancement rules are its own and a second copy would drift.

   Contract id: rtj.house.v1.  A breaking change gets a new id; ROYAL rejects
   a snapshot whose contract it does not know rather than guessing. */

export const CONTRACT = "rtj.house.v1";

const isNum = (v) => typeof v === "number" && isFinite(v);
const isStr = (v) => typeof v === "string";
const isOptStr = (v) => v === null || v === undefined || typeof v === "string";

export const STAGES = ["Inquiry", "Design", "CAD", "Awaiting approval", "Deposit due", "Production",
  "Quality control", "Balance due", "Ready", "Delivered", "Archived"];

/* Fields ROYAL must never receive.  The bridge whitelists what it sends; this
   is the second lock, on ROYAL's side of the door. */
const FORBIDDEN = /(password|secret|token|api[_-]?key|webhook|service[_-]?role|card[_-]?number|account[_-]?number|routing|ssn|address)/i;

function scanForbidden(v, path, errors, depth = 0) {
  if (depth > 8 || v === null || typeof v !== "object") return;
  for (const k of Object.keys(v)) {
    if (FORBIDDEN.test(k)) errors.push("forbidden field " + path + "." + k);
    scanForbidden(v[k], path + "." + k, errors, depth + 1);
  }
}

export function validateSnapshot(s) {
  const errors = [];
  if (!s || typeof s !== "object") return { ok: false, errors: ["snapshot is not an object"] };
  if (s.contract !== CONTRACT) errors.push("unknown contract " + JSON.stringify(s.contract) + ", expected " + CONTRACT);
  if (!isNum(s.generated_at)) errors.push("generated_at must be a timestamp");
  if (!Array.isArray(s.projects)) errors.push("projects must be an array");
  else s.projects.forEach((p, i) => {
    const at = "projects[" + i + "]";
    if (!isStr(p.id) || !p.id) errors.push(at + ".id is required");
    if (!isOptStr(p.name)) errors.push(at + ".name must be text");
    if (STAGES.indexOf(p.stage) < 0) errors.push(at + ".stage " + JSON.stringify(p.stage) + " is not a known stage");
    for (const f of ["value", "paid", "capital", "spent", "outstanding"]) if (!isNum(p[f])) errors.push(at + "." + f + " must be a number");
    if (!p.client || typeof p.client !== "object") errors.push(at + ".client is required");
    if (p.health && ["ok", "wait", "risk"].indexOf(p.health.s) < 0) errors.push(at + ".health.s is invalid");
  });
  if (!Array.isArray(s.clients)) errors.push("clients must be an array");
  if (!s.treasury || typeof s.treasury !== "object") errors.push("treasury is required");
  else if (s.treasury.inbox && !Array.isArray(s.treasury.inbox)) errors.push("treasury.inbox must be an array");
  scanForbidden(s, "snapshot", errors);
  if (s.projects && s.projects.length > 20000) errors.push("too many projects in one snapshot");
  return { ok: errors.length === 0, errors };
}
