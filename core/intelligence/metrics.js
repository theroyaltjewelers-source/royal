/* Observability.  Latency, counts, errors, token use and routing, for the
   developer view (GET /v1/developer/metrics).  Nothing here reaches the
   executive interface, and nothing here holds content or secrets: only names,
   numbers and outcomes. */

export class Metrics {
  constructor({ max = 500 } = {}) { this.series = new Map(); this.counters = new Map(); this.max = max; this.started = Date.now(); }
  observe(name, ms, { ok = true, tokens = 0 } = {}) {
    let s = this.series.get(name);
    if (!s) this.series.set(name, (s = { n: 0, errors: 0, tokens: 0, samples: [] }));
    s.n++; if (!ok) s.errors++; s.tokens += tokens || 0;
    s.samples.push(ms); if (s.samples.length > this.max) s.samples.shift();
  }
  count(name, by = 1) { this.counters.set(name, (this.counters.get(name) || 0) + by); }
  snapshot() {
    const pct = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
    const series = {};
    for (const [k, s] of this.series) series[k] = { count: s.n, errors: s.errors, tokens: s.tokens, p50_ms: pct(s.samples, 0.5), p95_ms: pct(s.samples, 0.95) };
    return { since: this.started, series, counters: Object.fromEntries(this.counters) };
  }
}
