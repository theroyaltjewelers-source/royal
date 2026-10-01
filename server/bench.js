/* The latency benchmark: `npm run bench`.

   Asks a running ROYAL the benchmark questions, several times each, and
   prints p50 and p95 per category: the full round trip as the browser sees
   it, ROYAL's own time (result.timing), and model calls per request.  Run
   it against the real server (with XAI_API_KEY there) to measure what Tahir
   feels; run it locally to measure ROYAL's own overhead.

     ROYAL_URL=https://royal-1wx5.onrender.com ROYAL_TOKEN=<session token> npm run bench
     ROYAL_BENCH_RUNS=5 (default 3)

   The token is the one the web app keeps after sign-in (localStorage
   "royal.session").  Nothing it prints contains it. */

const URL_ = (process.env.ROYAL_URL || "http://localhost:8787").replace(/\/$/, "");
const TOKEN = process.env.ROYAL_TOKEN || process.env.ROYAL_DEV_OWNER_TOKEN;
const RUNS = Math.max(1, Number(process.env.ROYAL_BENCH_RUNS || 3));
if (!TOKEN) { console.error("Set ROYAL_TOKEN to a signed-in session token (or ROYAL_DEV_OWNER_TOKEN locally)."); process.exit(1); }

export const BENCHMARK = [
  ["GREETING", "Hey ROYAL"],
  ["IDENTITY", "Who are you?"],
  ["SIMPLE CALCULATION", "What's 20% of 5000?"],
  ["INTERNAL LOOKUP", "What does Marcus owe?"],
  ["HOUSE OPERATIONS", "What needs me?"],
  ["HOUSE KNOWLEDGE", "What does production deposit mean?"],
  ["HOUSE POLICY", "What is our warranty policy?"],
  ["WORLD FACT", "Who founded Nike?"],
  ["CURRENT EXECUTIVE", "Who is Nike's current CFO?"],
  ["OPEN QUESTION", "Give me your read on this week's workload"],
];

const pct = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

const rows = [];
for (const [cat, q] of BENCHMARK) {
  const wall = [], server = [], calls = [], paths = new Set();
  for (let i = 0; i < RUNS; i++) {
    const t0 = Date.now();
    const r = await fetch(URL_ + "/v1/command", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
      body: JSON.stringify({ content: q, conversation_id: "bench-" + cat.toLowerCase().replace(/\W+/g, "-") + "-" + i }) });
    const j = await r.json().catch(() => ({}));
    wall.push(Date.now() - t0);
    const t = j.result && j.result.timing;
    if (t) { server.push(t.total_ms); calls.push(t.model_calls); paths.add(t.path); }
  }
  rows.push({ category: cat, wall_p50: pct(wall, 0.5), wall_p95: pct(wall, 0.95), royal_p50: pct(server, 0.5), royal_p95: pct(server, 0.95),
    model_calls: calls.length ? Math.max(...calls) : null, path: [...paths].join(" ") });
}
console.table(rows);
