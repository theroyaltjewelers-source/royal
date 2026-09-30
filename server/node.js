/* Node entry: `node server/node.js`.  Serves the API under /v1 and the ROYAL
   web app from web/ on the same origin. */

import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHandler, fromEnv } from "./handler.js";
import { fileStore, MemoryStore } from "../core/store.js";
import { GrokProvider } from "../core/providers/grok.js";
import { UnavailableProvider } from "../core/providers/provider.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB = join(ROOT, "web");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };

async function staticFiles(path) {
  const rel = path === "/" ? "/index.html" : path;
  const file = normalize(join(WEB, rel));
  if (!file.startsWith(WEB + "/")) return null;
  try {
    const buf = await readFile(file);
    return new Response(buf, { headers: { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' https:; img-src 'self' data:; frame-ancestors 'self' " + (process.env.ROYAL_ALLOWED_ORIGINS || "").split(",").join(" ") } });
  } catch { return null; }
}

const env = process.env;
const store = env.ROYAL_STORE_PATH ? await fileStore(env.ROYAL_STORE_PATH) : new MemoryStore();
if (!env.ROYAL_STORE_PATH) console.warn("ROYAL: ROYAL_STORE_PATH is not set; decisions and audit are in memory and will be lost on restart.");
const { royal, auth, allowedOrigins, passcode } = await fromEnv(env, {
  store,
  providerFactory: (e) => (e.XAI_API_KEY || e.ROYAL_GROK_MODEL ? new GrokProvider({ apiKey: e.XAI_API_KEY, model: e.ROYAL_GROK_MODEL }) : new UnavailableProvider("XAI_API_KEY and ROYAL_GROK_MODEL are not set.")),
});
const handler = createHandler({ royal, auth, passcode, allowedOrigins, staticFiles });

const server = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request("http://" + (req.headers.host || "localhost") + req.url, {
      method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
    const r = await handler(request);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "SERVER_ERROR" }));
  }
});
const port = Number(env.PORT || 8787);
server.listen(port, () => console.log("ROYAL listening on http://localhost:" + port));
