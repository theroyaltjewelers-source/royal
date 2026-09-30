/* Client message drafts.  Deterministic, so a draft never contains a date,
   price or promise that is not already in the verified record (policy
   POL-COM-003).  A language provider may later polish tone; it may not add
   facts.  Every draft is a RECOMMENDATION and is sent only after approval. */

import { money } from "../core/util.js";

function first(name) { return String(name || "").trim().split(/\s+/)[0] || "there"; }

export function draftFor(item, ctx) {
  const e = item.entity || {};
  const hi = "Hi " + first(e.client_name) + ",\n\n";
  const sign = "\n\nWarm regards,\nThe House of Royal T";
  switch (item.code) {
    case "BALANCE_ON_FINISHED":
      return { purpose: "a balance reminder", label: "RECOMMENDATION",
        body: hi + "Your " + (e.name || "piece") + " is finished and ready for you. The remaining balance is " + money(item.amount) +
          ". Once it is settled we will arrange collection or delivery at a time that suits you." + sign };
    case "PRODUCTION_SHORT_MOVING":
    case "PRODUCTION_UNFUNDED":
      return { purpose: "a production deposit request", label: "RECOMMENDATION",
        body: hi + "To keep your " + (e.name || "commission") + " moving through production, the next payment of " + money(item.amount) +
          " is now due. Let us know if you would like the payment details sent again." + sign };
    case "PAST_TARGET":
      return { purpose: "a timeline update", label: "RECOMMENDATION",
        body: hi + "A quick update on your " + (e.name || "commission") + ". It is taking longer than the date we first gave you. We are confirming the finish date with our workshop now and will come back to you with a firm date shortly." + sign };
    case "WAITING_LONG":
      if (e.stage === "Awaiting approval")
        return { purpose: "a design approval reminder", label: "RECOMMENDATION",
          body: hi + "Your design for the " + (e.name || "commission") + " is ready for your approval. Once you confirm, we can move it forward. Happy to walk through any changes with you." + sign };
      return null;
    default:
      return null;
  }
}
