/* Plain words for things going wrong.  Shared by the server (core/) and the
   browser, like schema.js, so an answer and a banner describe a failure the
   same way.  Pure functions: no DOM, no network, no secrets.  Provider error
   text is only read to classify it; it is never echoed back. */

const CREDIT_WORDS = /credit|spending limit|spend limit|billing|balance|purchase|payment|quota|insufficient|exhausted/i;

/* Why the language provider (xAI Grok) did not answer, from a failure
   ({ failed_because, detail }) or from a provider status ({ status, detail }).
   Returns null when the provider is fine. */
export function providerProblem(x) {
  if (!x) return null;
  let code = String(x.failed_because || ""), detail = String(x.detail || "");
  if (!code && x.status) {
    if (x.status === "CONNECTED") return null;
    if (x.status === "NOT_CONNECTED") code = "PROVIDER_NOT_CONNECTED";
    else {
      const m = /HTTP (\d{3})/.exec(detail);
      code = m ? "PROVIDER_HTTP_" + m[1] : /timeout/i.test(detail) ? "PROVIDER_TIMEOUT" : /network/i.test(detail) ? "PROVIDER_NETWORK" : /empty/i.test(detail) ? "PROVIDER_EMPTY_REPLY" : "PROVIDER_DEGRADED";
    }
  }
  if (!/^PROVIDER_/.test(code)) return null;
  const http = /^PROVIDER_HTTP_(\d{3})$/.exec(code), n = http ? Number(http[1]) : 0;
  let kind, why, fix;
  if (code === "PROVIDER_NOT_CONNECTED") { kind = "not_set_up"; why = "it isn't set up on the server (no xAI key or model)"; fix = "Add XAI_API_KEY and ROYAL_GROK_MODEL on the server, then redeploy."; }
  else if ((n === 402 || n === 403 || n === 429) && CREDIT_WORDS.test(detail)) { kind = "credits"; why = "the xAI account is out of credits or has hit its spending limit"; fix = "Add credits or raise the limit at console.x.ai, then try again."; }
  else if (n === 402) { kind = "credits"; why = "xAI says payment is required (usually no credits left)"; fix = "Check the balance at console.x.ai, then try again."; }
  else if (n === 401) { kind = "key"; why = "xAI rejected the API key"; fix = "Check XAI_API_KEY on the server."; }
  else if (n === 403) { kind = "refused"; why = "xAI refused the request (often no credits left, or the key lacks access to this model)"; fix = "Check credits and model access at console.x.ai."; }
  else if (n === 429) { kind = "busy"; why = "xAI is limiting how fast I can ask"; fix = "Wait a minute and try again."; }
  else if (n === 404) { kind = "model"; why = "xAI doesn't recognise the model name"; fix = "Check ROYAL_GROK_MODEL on the server."; }
  else if (n >= 500) { kind = "outage"; why = "xAI is having trouble on its side"; fix = "Try again in a few minutes."; }
  else if (code === "PROVIDER_TIMEOUT") { kind = "slow"; why = "xAI took too long to answer"; fix = "Try again; a shorter question may help."; }
  else if (code === "PROVIDER_NETWORK") { kind = "network"; why = "the server couldn't reach xAI"; fix = "Try again in a moment."; }
  else if (code === "PROVIDER_EMPTY_REPLY") { kind = "empty"; why = "xAI sent back an empty answer"; fix = "Try asking again."; }
  else { kind = "other"; why = "xAI didn't answer" + (n ? " (error " + n + ")" : ""); fix = "Try again in a moment."; }
  return { kind, code, why, fix, title: kind === "busy" || kind === "slow" || kind === "empty" ? "AI brain struggling" : "AI brain offline" };
}

/* One sentence for an answer: what failed, in plain words.  The caller adds
   what was (not) done. */
export function providerLine(failure) {
  const p = providerProblem(failure);
  return p ? "My AI brain (xAI Grok) didn't answer: " + p.why + "." : "My AI brain (xAI Grok) didn't answer.";
}

/* A banner for the page, or null. */
export function providerNotice(status) {
  const p = providerProblem(status);
  if (!p) return null;
  return { tone: p.kind === "busy" || p.kind === "slow" || p.kind === "empty" ? "calm" : "attention", title: p.title, text: capital(p.why) + ". " + p.fix + " House questions still work." };
}

/* What to say when the ROYAL server itself answered badly or not at all. */
export function serverProblem({ status = 0, network = false } = {}) {
  if (network) return "ROYAL's server couldn't be reached. Check your internet connection. Nothing was done.";
  if (status === 502 || status === 503 || status === 504) return "ROYAL's server is restarting or overloaded (error " + status + "). Nothing was done. Try again in a minute.";
  if (status === 404) return "This version of the app asked the server for something it doesn't have (error 404). The web app and server may be out of step; reload the page. Nothing was done.";
  if (status >= 500) return "ROYAL's server hit an internal error (error " + status + "). Nothing was done. Try again; if it keeps happening, check the server logs.";
  return "ROYAL's server sent back a reply the app couldn't read" + (status ? " (error " + status + ")" : "") + ". Nothing was done.";
}

function capital(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
