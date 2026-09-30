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
import { bridgeFromEnv } from "../core/grokbot/bridge.js";
import { nodeAdapter } from "./node-adapter.js";

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
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' https:; img-src 'self' data:; frame-ancestors 'self' " + (process.env.ROYAL_ALLOWED_ORIGINS || "").split(",").join(" ") } });
  } catch { return null; }
}

const env = process.env;
const store = env.ROYAL_STORE_PATH ? await fileStore(env.ROYAL_STORE_PATH) : new MemoryStore();
if (!env.ROYAL_STORE_PATH) console.warn("ROYAL: ROYAL_STORE_PATH is not set; decisions and audit are in memory and will be lost on restart.");
const { royal, auth, allowedOrigins, passcode } = await fromEnv(env, {
  store,
  providerFactory: (e) => (e.XAI_API_KEY || e.ROYAL_GROK_MODEL ? new GrokProvider({ apiKey: e.XAI_API_KEY, model: e.ROYAL_GROK_MODEL }) : new UnavailableProvider("XAI_API_KEY and ROYAL_GROK_MODEL are not set.")),
});
/* The Grok Bot bridge: Postgres when DATABASE_URL is set (migrations run on
   start unless ROYAL_AUTO_MIGRATE=false), memory otherwise. */
const bridge = await bridgeFromEnv(env, { migrationsDir: join(ROOT, "server", "migrations") });
const handler = createHandler({ royal, auth, passcode, bridge, allowedOrigins, staticFiles });

const server = http.createServer(nodeAdapter(handler));
/* requestTimeout bounds how long a request may take to arrive (a slow upload),
   not how long a response may last, so live streams are unaffected; their 25
   second heartbeat keeps proxies from closing them. */
server.requestTimeout = 60000;
server.headersTimeout = 65000;
server.keepAliveTimeout = 65000;
const port = Number(env.PORT || 8787);
server.listen(port, () => console.log("ROYAL listening on http://localhost:" + port));

