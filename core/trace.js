/* Request tracing: how long each request took and where the time went.

   One trace per request, carried through every await by AsyncLocalStorage,
   so the provider can record its calls without each caller passing a trace
   along.  A trace holds named marks (milliseconds since the request
   arrived), every model call (kind, duration, reasoning effort, tokens,
   cached tokens) and the conversation id the provider uses as its prompt
   cache key.  Nothing here holds content: only names and numbers. */

import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();

export function runTraced(info, fn) {
  const t = { started: Date.now(), marks: {}, calls: [], conversation: info.conversation || null, path: null };
  return als.run(t, () => fn(t));
}

export function currentTrace() { return als.getStore() || null; }

/* Record the first time something happened in this request. */
export function mark(name) {
  const t = als.getStore(); if (!t) return;
  if (t.marks[name] === undefined) t.marks[name] = Date.now() - t.started;
}

export function setPath(name) { const t = als.getStore(); if (t && !t.path) t.path = name; }

export function recordModelCall(call) {
  const t = als.getStore(); if (!t) return;
  if (!t.calls.length) t.marks.first_model_request = Math.max(0, Date.now() - t.started - (call.ms || 0));
  t.calls.push(call);
}

/* The summary attached to a result and fed to metrics. */
export function timingOf(t) {
  if (!t) return null;
  const total = Date.now() - t.started;
  return { total_ms: total, path: t.path || "unknown", marks: { ...t.marks, final: total },
    model_calls: t.calls.length, model_ms: t.calls.reduce((a, c) => a + (c.ms || 0), 0),
    calls: t.calls.map((c) => ({ kind: c.kind, ms: c.ms, ok: c.ok, effort: c.effort || null, tokens: c.tokens || 0, cached_tokens: c.cached_tokens || 0 })) };
}
