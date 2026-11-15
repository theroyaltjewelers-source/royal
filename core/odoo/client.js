/* Odoo 19 and 20 external JSON-2 API.
   POST {origin}/json/2/<model>/<method>
   Authorization: bearer <api key>   (lowercase scheme, as the 19.0 and 20.0 docs specify)
   X-Odoo-Database: <database>
   Body: a JSON object of named arguments, plus ids and context. No positional args.
   A 2xx body is the method's return value. An error body is {name, message, arguments, debug};
   only name and message are kept. debug (a traceback) is never returned or logged. */

export function redact(text, secrets) {
  let out = String(text == null ? "" : text);
  for (const s of secrets || []) {
    if (typeof s === "string" && s.length >= 8 && out.includes(s)) out = out.split(s).join("[redacted]");
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 400);
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined) out[k] = v;
  return out;
}

const RETRY_STATUSES = new Set([429, 503]);

/* Retry-After is either seconds or an HTTP date. Missing or unreadable
   values fall back to 1s, 2s, 4s, capped at 30s. A present value is honored
   up to 120s so one huge header cannot stall a pass. */
export function retryWaitMs(attempt, retryAfter, now = Date.now()) {
  if (retryAfter != null && String(retryAfter).trim() !== "") {
    const raw = String(retryAfter).trim();
    if (/^\d+(\.\d+)?$/.test(raw)) return Math.min(120000, Math.max(0, Math.round(Number(raw) * 1000)));
    const when = Date.parse(raw);
    if (Number.isFinite(when)) return Math.min(120000, Math.max(0, when - now));
  }
  return Math.min(30000, 1000 * 2 ** attempt);
}

export function createdId(result) {
  if (typeof result === "number" && Number.isFinite(result)) return result;
  if (Array.isArray(result)) {
    const first = result[0];
    if (typeof first === "number" && Number.isFinite(first)) return first;
    if (first && typeof first === "object" && Number.isFinite(first.id)) return first.id;
  }
  if (result && typeof result === "object" && Number.isFinite(result.id)) return result.id;
  return null;
}

export function createOdooClient({ url, database, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 20000, minIntervalMs = 250, maxRetries = 5, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now() }) {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.username || u.password) throw new Error("ODOO_URL must be https, with no password in it.");
  const origin = u.origin;
  const secrets = [apiKey];
  /* One call at a time, with a gap, so a page of payments cannot burst
     Odoo Online into HTTP 429. */
  let chain = Promise.resolve();
  let nextAt = 0;
  function paced(fn) {
    const run = chain.then(async () => {
      const wait = nextAt - now();
      if (minIntervalMs > 0 && wait > 0) await sleep(wait);
      try { return await fn(); }
      finally { if (minIntervalMs > 0) nextAt = now() + minIntervalMs; }
    });
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function call(model, method, payload) {
    if (!/^[A-Za-z0-9_.]+$/.test(model) || !/^[A-Za-z0-9_]+$/.test(method)) throw new Error("Unexpected Odoo model or method.");
    return paced(() => attempt(model, method, payload, 0));
  }

  async function attempt(model, method, payload, n) {
    let res;
    try {
      res = await fetchImpl(origin + "/json/2/" + model + "/" + method, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "Authorization": "bearer " + apiKey,
          "Content-Type": "application/json; charset=utf-8",
          "X-Odoo-Database": database,
          "User-Agent": "ROYAL-odoo-sync/1",
        },
        body: JSON.stringify(payload || {}),
      });
    } catch (e) {
      throw new Error("I could not reach Odoo. " + redact(e.message, secrets));
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    if (RETRY_STATUSES.has(res.status) && n < maxRetries) {
      await sleep(retryWaitMs(n, res.headers.get("retry-after"), now()));
      return attempt(model, method, payload, n + 1);
    }
    if (!res.ok) {
      const why = (json && typeof json.message === "string" && json.message) || (json && json.name) || ("HTTP " + res.status);
      const err = new Error("Odoo refused " + model + "." + method + ": " + redact(why, secrets));
      err.status = res.status;
      throw err;
    }
    return json;
  }

  return {
    call,
    async searchRead(model, { domain, fields, limit, order, context } = {}) {
      const rows = await call(model, "search_read", clean({ domain, fields, limit, order, context }));
      if (!Array.isArray(rows)) throw new Error("Odoo search_read on " + model + " did not return a list.");
      return rows;
    },
    async read(model, ids, fields, context) {
      const rows = await call(model, "read", clean({ ids, fields, context }));
      if (!Array.isArray(rows)) throw new Error("Odoo read on " + model + " did not return a list.");
      return rows;
    },
    async create(model, vals) {
      const id = createdId(await call(model, "create", { vals_list: [vals] }));
      if (!id) throw new Error("Odoo create on " + model + " did not return an id.");
      return id;
    },
    async write(model, ids, vals, context) {
      return call(model, "write", clean({ ids, vals, context }));
    },
    async exec(model, method, ids, extra) {
      return call(model, method, clean({ ids, ...(extra || {}) }));
    },
  };
}
