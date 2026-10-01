/* Node entry: `node server/node.js`.  Serves the API under /v1 and the ROYAL
   web app from web/ on the same origin. */

import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHandler, fromEnv } from "./handler.js";
import { GrokProvider } from "../core/providers/grok.js";
import { UnavailableProvider } from "../core/providers/provider.js";
import { bridgeFromEnv } from "../core/grokbot/bridge.js";
import { storeFromEnv } from "./store-env.js";
import { nodeAdapter } from "./node-adapter.js";
import { intelligenceFromEnv } from "./intelligence-env.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB = join(ROOT, "web");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8" };

/* iOS asks for these by name when ROYAL is added to the home screen. */
const ALIAS = { "/": "/index.html", "/apple-touch-icon-precomposed.png": "/apple-touch-icon.png", "/favicon.ico": "/apple-touch-icon.png" };
async function staticFiles(path) {
  const rel = ALIAS[path] || path;
  const file = normalize(join(WEB, rel));
  if (!file.startsWith(WEB + "/")) return null;
  try {
    const buf = await readFile(file);
    return new Response(buf, { headers: { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' https: wss://api.x.ai; img-src 'self' data:; frame-ancestors 'self' " + (process.env.ROYAL_ALLOWED_ORIGINS || "").split(",").join(" ") } });
  } catch { return null; }
}

const env = process.env;
/* ROYAL's own store: Postgres when DATABASE_URL is set, else the JSON file at
   ROYAL_STORE_PATH, else memory (warned).  With Postgres, one migrated pool
   serves both the store and the Grok Bot bridge. */
const { store, pool } = await storeFromEnv(env, { migrationsDir: join(ROOT, "server", "migrations") });
const bridge = await bridgeFromEnv(env, { migrationsDir: join(ROOT, "server", "migrations"), pool });
/* The intelligence layer's parts: House knowledge, safe fetching, contact
   providers, email, metrics.  Each reports NOT CONFIGURED without its key. */
const intel = await intelligenceFromEnv(env, { docsDir: join(ROOT, "docs") });
const { royal, auth, allowedOrigins, passcode } = await fromEnv(env, {
  store, extras: { ...intel, bridge },
  providerFactory: (e) => (e.XAI_API_KEY || e.ROYAL_GROK_MODEL ? new GrokProvider({ apiKey: e.XAI_API_KEY, model: e.ROYAL_GROK_MODEL, fastModel: e.ROYAL_GROK_FAST_MODEL,
    voiceModel: e.ROYAL_VOICE_MODEL || "grok-voice-latest", voice: e.ROYAL_VOICE || "ara", metrics: intel.metrics }) : new UnavailableProvider("XAI_API_KEY and ROYAL_GROK_MODEL are not set.")),
});
/* One JSON line per API request and per failed request (route folded, no
   bodies, queries or tokens), so every 4xx and 5xx can be traced in the
   Render log.  ROYAL_ACCESS_LOG=off silences it. */
const log = env.ROYAL_ACCESS_LOG === "off" ? null : (l) => console.log("ROYAL_ACCESS " + JSON.stringify(l));
const handler = createHandler({ royal, auth, passcode, bridge, allowedOrigins, staticFiles, log });

const server = http.createServer(nodeAdapter(handler));
/* requestTimeout bounds how long a request may take to arrive (a slow upload),
   not how long a response may last, so live streams are unaffected; their 25
   second heartbeat keeps proxies from closing them. */
server.requestTimeout = 60000;
server.headersTimeout = 65000;
server.keepAliveTimeout = 65000;
const port = Number(env.PORT || 8787);
server.listen(port, () => console.log("ROYAL listening on http://localhost:" + port));

