/* The shared vocabulary of ROYAL.  Every other module speaks in these terms,
   so a value that is not listed here is a bug, not a new idea.  Frozen so a
   caller cannot quietly add a permission class at runtime. */

const freeze = (o) => Object.freeze(o);
const set = (...xs) => freeze(Object.fromEntries(xs.map((x) => [x, x])));

/* Realms separate what is Tahir's business from what is Tahir's own.  A
   specialist scoped to one realm cannot read the other; see permissions.js. */
export const REALM = set("BUSINESS", "PERSONAL");

export const PRIORITY = set("P0", "P1", "P2", "P3", "P4");
export const PRIORITY_RANK = freeze({ P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 });
export const PRIORITY_LABEL = freeze({
  P0: "Critical", P1: "Action today", P2: "Action this week", P3: "Monitor", P4: "Information",
});

/* Risk is a different axis from priority.  A BLACK risk can be P3 if nothing
   can be done today; a GREEN item can be P1 if it has a deadline this
   afternoon. */
export const RISK = set("GREEN", "YELLOW", "ORANGE", "RED", "BLACK");
export const RISK_RANK = freeze({ GREEN: 0, YELLOW: 1, ORANGE: 2, RED: 3, BLACK: 4 });

/* What Tahir would have to do about an item.  NONE means it stays off the
   executive surface entirely. */
export const NEED = set("KNOW", "DECIDE", "APPROVE", "DO", "DELEGATE", "MONITOR", "NONE");

export const EVIDENCE = set("VERIFIED", "REPORTED_UNVERIFIED", "INFERENCE", "RECOMMENDATION", "UNKNOWN");

export const FRESHNESS = set("CURRENT", "RECENT", "STALE", "UNKNOWN");

export const PERMISSION = set("READ", "ANALYZE", "DRAFT", "INTERNAL_WRITE", "APPROVAL_REQUIRED", "PROHIBITED");

export const REVERSIBILITY = set("REVERSIBLE", "PARTIALLY_REVERSIBLE", "DIFFICULT_TO_REVERSE", "IRREVERSIBLE");

export const DECISION_TYPE = set(
  "SEND_CLIENT_MESSAGE", "PRICING_EXCEPTION", "REFUND", "RUSH_REQUEST", "PRODUCTION_CHANGE",
  "VENDOR_PAYMENT", "POLICY_EXCEPTION", "POLICY_CHANGE", "POLICY_GAP", "CONTRACT", "DEPLOYMENT",
  "DATA_DELETION", "INTERNAL_ACTION", "SOURCE_CONFLICT", "GENERAL",
);

export const DECISION_STATUS = set("OPEN", "APPROVED", "MODIFIED", "REJECTED", "EXECUTED", "FAILED", "VERIFIED", "EXPIRED", "CANCELLED");

export const COMMITMENT_STATUS = set("OPEN", "DUE_SOON", "OVERDUE", "REPORTED_COMPLETE", "VERIFIED_COMPLETE", "CANCELLED");

export const WAITING_TYPE = set(
  "CLIENT", "PAYMENT", "CAD", "APPROVAL", "MATERIALS", "STONES", "SETTER", "MANUFACTURER",
  "SHIPPING", "STAFF", "AGENT", "TAHIR", "EXTERNAL_PARTY",
);

export const RUN_STATUS = set("OK", "PARTIAL", "NEEDS_CLARIFICATION", "FAILED", "NOT_CONNECTED");

export const MODALITY = set("text", "voice", "ui_action", "automation", "business_event");

export const EVENT_TYPE = set(
  "PAYMENT_RECEIVED", "PAYMENT_OVERDUE", "CLIENT_MESSAGE_RECEIVED", "CLIENT_UPDATE_DUE",
  "LEAD_CREATED", "LEAD_QUALIFIED", "CONSULTATION_SCHEDULED", "DESIGN_DEPOSIT_RECEIVED",
  "CAD_RECEIVED", "CAD_APPROVED", "PRODUCTION_STAGE_CHANGED", "MATERIALS_RECEIVED",
  "VENDOR_STATUS_CHANGED", "SHIPMENT_CREATED", "SHIPMENT_DELAYED", "QC_COMPLETED", "PROJECT_READY",
  "APPOINTMENT_CREATED", "COMMITMENT_CREATED", "COMMITMENT_DUE", "COMMITMENT_OVERDUE",
  "DECISION_REQUIRED", "SYSTEM_ERROR", "INTEGRATION_FAILED", "DATA_CONFLICT_DETECTED",
  "SNAPSHOT_INGESTED",
);

/* Automation maturity.  A capability climbs one rung at a time and never
   skips to the top. */
export const MATURITY = freeze(["OBSERVE", "ANALYZE", "RECOMMEND", "DRAFT", "INTERNAL_ACTION", "APPROVED_EXTERNAL_ACTION", "LIMITED_STANDING_AUTONOMY"]);

export const CONNECTION = set("CONNECTED", "NOT_CONNECTED", "DEGRADED", "ERROR");
