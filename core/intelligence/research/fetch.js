/* Fetching a web page safely.

   Research reads pages named by search results, and search results come from
   the open web, so every fetch is treated as hostile input:

   (a) Only http and https, only ports 80 and 443, no credentials in the URL.
   (b) SSRF: the address the connection actually uses is checked at connect
       time (a custom DNS lookup on the socket), so a name that resolves to a
       private, loopback, link-local, carrier-grade NAT, multicast or cloud
       metadata address is refused, including after a redirect and including
       DNS rebinding between check and connect.  IP literals in any notation
       (including IPv4 inside IPv6) are refused, and the connected socket's
       address is checked again.
   (c) Redirects are followed by hand, at most three, each re-checked.
   (d) At most 1.5 MB is read, within 12 seconds in total.  Only text types.
       HTML is turned into text in one linear pass.
   (e) What comes back is text for evidence.  It never becomes an instruction:
       callers pass it to models only inside a data envelope. */

import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";

const MAX_BYTES = 1500000, TIMEOUT = 12000, MAX_REDIRECTS = 3, MAX_HTML = 600000;
const TEXT_TYPES = /^(text\/(html|plain)|application\/(xhtml\+xml|json|xml)|text\/xml)/i;

/* Expands any IPv6 text form to eight 16-bit groups. */
function ipv6Groups(ip) {
  let x = ip.toLowerCase().replace(/%.*$/, "");
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (v4) { const p = v4[1].split(".").map(Number); x = x.slice(0, -v4[1].length) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16); }
  const [head, tail] = x.split("::");
  const h = head ? head.split(":") : [], t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = x.includes("::") ? new Array(8 - h.length - t.length).fill("0") : [];
  const g = [...h, ...fill, ...t].map((v) => parseInt(v || "0", 16));
  return g.length === 8 && g.every((n) => n >= 0 && n <= 0xffff) ? g : null;
}
const v4FromGroups = (a, b) => [a >> 8, a & 255, b >> 8, b & 255].join(".");

/* Anything that is not a plain public unicast address is refused, in every
   notation: IPv4, IPv6, and IPv4 embedded in IPv6 (mapped, compatible,
   NAT64, 6to4). */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const g = ipv6Groups(ip);
    if (!g) return true;
    if (g.every((n) => n === 0)) return true;                                        /* :: */
    if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true;             /* ::1 */
    if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0xffff || g[5] === 0)) return isPrivateAddress(v4FromGroups(g[6], g[7]));   /* mapped, compatible */
    if (g[0] === 0x64 && g[1] === 0xff9b) return isPrivateAddress(v4FromGroups(g[6], g[7]));                                        /* NAT64 */
    if (g[0] === 0x2002) return isPrivateAddress(v4FromGroups(g[1], g[2]));                                                            /* 6to4 */
    if ((g[0] & 0xfe00) === 0xfc00) return true;                                     /* unique local fc00::/7 */
    if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true;       /* link-local, site-local */
    if ((g[0] & 0xff00) === 0xff00) return true;                                     /* multicast */
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true;                             /* documentation */
    if (g[0] === 0x2001 && g[1] < 0x200) return true;                                /* Teredo and IETF special */
    return false;
  }
  return true;
}

function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: options.family || 4 }];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || !list.length) return cb(Object.assign(new Error("BLOCKED_ADDRESS"), { code: "BLOCKED_ADDRESS" }));
    if (options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

export function checkUrl(raw) {
  let u; try { u = new URL(raw); } catch (_) { return { ok: false, reason: "BAD_URL" }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "SCHEME_NOT_ALLOWED" };
  if (u.username || u.password) return { ok: false, reason: "CREDENTIALS_IN_URL" };
  if (u.port && u.port !== "80" && u.port !== "443") return { ok: false, reason: "PORT_NOT_ALLOWED" };
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isPrivateAddress(host)) return { ok: false, reason: "BLOCKED_ADDRESS" };
  if (/^(localhost|metadata|metadata\.google\.internal)$/i.test(host) || /\.(local|internal|localhost)$/i.test(host)) return { ok: false, reason: "BLOCKED_HOST" };
  return { ok: true, url: u };
}

function getOnce(u, { lookup = guardedLookup, timeout = TIMEOUT, guard = isPrivateAddress }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; clearTimeout(deadline); resolve(r); };
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method: "GET", lookup, timeout, headers: { "User-Agent": "ROYAL-Research/1.0 (business research)", Accept: "text/html,text/plain;q=0.9,*/*;q=0.1" } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) { res.resume(); return done({ redirect: new URL(res.headers.location, u).toString(), status }); }
      const type = String(res.headers["content-type"] || "");
      if (!TEXT_TYPES.test(type)) { res.resume(); return done({ ok: false, reason: "NOT_TEXT", status }); }
      const chunks = []; let size = 0;
      res.on("data", (c) => { size += c.length; if (size > MAX_BYTES) { req.destroy(); done({ ok: false, reason: "TOO_LARGE", status }); } else chunks.push(c); });
      res.on("end", () => done({ ok: status >= 200 && status < 300, status, type, body: Buffer.concat(chunks).toString("utf8"), reason: status >= 400 ? "HTTP_" + status : null }));
      res.on("error", () => done({ ok: false, reason: "READ_ERROR", status }));
    });
    /* A total deadline, not just an idle timeout: a server that drips bytes
       cannot hold a research request open. */
    const deadline = setTimeout(() => { req.destroy(); done({ ok: false, reason: "TIMEOUT" }); }, timeout);
    /* Belt and braces: the address actually connected to is checked too.
       Node skips the custom lookup for IP literals, so this is what catches
       an IPv6 form that slipped past checkUrl. */
    req.on("socket", (sock) => sock.once("connect", () => { if (guard(sock.remoteAddress || "")) { req.destroy(); done({ ok: false, reason: "BLOCKED_ADDRESS" }); } }));
    req.on("timeout", () => { req.destroy(); done({ ok: false, reason: "TIMEOUT" }); });
    req.on("error", (e) => done({ ok: false, reason: e.code === "BLOCKED_ADDRESS" ? "BLOCKED_ADDRESS" : "UNREACHABLE" }));
    req.end();
  });
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };
/* HTML to text in one linear pass (no backtracking regular expressions: a
   hostile page of unclosed tags must not freeze the server).  Input is
   capped before parsing. */
const SKIP = ["script", "style", "noscript", "svg", "template"];
const BREAK = /^\/?(p|div|li|h[1-6]|tr|section|article|br)\b/i;
function decode(t) {
  return t.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (m, e) => {
    if (e[0] !== "#") return ENT[e.toLowerCase()] || " ";
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
  });
}
export function htmlToText(html) {
  const s = String(html || "").slice(0, MAX_HTML), low = s.toLowerCase();
  let out = "", i = 0, title = "";
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) { out += s.slice(i); break; }
    out += s.slice(i, lt);
    if (s.startsWith("<!--", lt)) { const e = s.indexOf("-->", lt + 4); if (e < 0) break; i = e + 3; out += " "; continue; }
    const gt = s.indexOf(">", lt + 1);
    if (gt < 0) break;                                   /* an unclosed tag ends the text */
    const tag = s.slice(lt + 1, gt).trim(), name = (/^[a-z0-9]+/i.exec(tag) || [""])[0].toLowerCase();
    if (SKIP.includes(name)) { const e = low.indexOf("</" + name, gt + 1); if (e < 0) break; const e2 = s.indexOf(">", e); if (e2 < 0) break; i = e2 + 1; out += " "; continue; }
    if (name === "title" && !title) { const e = low.indexOf("</title", gt + 1); if (e >= 0) title = s.slice(gt + 1, e); }
    out += BREAK.test(tag) ? "\n" : " ";
    i = gt + 1;
  }
  const text = decode(out).replace(/[ \t\f\v]+/g, " ").replace(/\n[ \t]*/g, "\n").replace(/\n{2,}/g, "\n").trim();
  return { title: decode(title).replace(/\s+/g, " ").trim(), text: text.slice(0, 200000) };
}

export class SafeFetcher {
  /* `lookup`, `guard` and `timeout` are replaceable only so tests can reach
     a local server; the product always uses the defaults. */
  constructor({ lookup = guardedLookup, guard = isPrivateAddress, timeout = TIMEOUT, clock = () => Date.now(), metrics = null } = {}) {
    this.lookup = lookup; this.guard = guard; this.timeout = timeout; this.clock = clock; this.metrics = metrics;
  }
  async fetch(raw) {
    const t0 = Date.now();
    let url = raw;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const c = checkUrl(url);
      if (!c.ok) return this._done(t0, { ok: false, url: raw, reason: c.reason });
      const r = await getOnce(c.url, { lookup: this.lookup, guard: this.guard, timeout: this.timeout });
      if (r.redirect) { url = r.redirect; continue; }
      if (!r.ok) return this._done(t0, { ok: false, url: raw, final_url: url, reason: r.reason, status: r.status });
      const { title, text } = /html|xml/i.test(r.type) ? htmlToText(r.body) : { title: "", text: r.body.slice(0, 200000) };
      return this._done(t0, { ok: true, url: raw, final_url: url, status: r.status, title, text, fetched_at: this.clock() });
    }
    return this._done(t0, { ok: false, url: raw, reason: "TOO_MANY_REDIRECTS" });
  }
  _done(t0, r) { if (this.metrics) this.metrics.observe("tool.web_fetch", Date.now() - t0, { ok: r.ok }); return r; }
}
