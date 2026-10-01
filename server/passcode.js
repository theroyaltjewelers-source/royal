/* ROYAL's own sign-in.  An owner passcode, checked by ROYAL's server, and a
   session token that ROYAL itself signs.  No email, no third-party account,
   nothing shared with the calculator.

   Token format:  rs1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, payload))>
   payload:       {"sub":"owner","iat":<ms>,"exp":<ms>}

   Environment:
     ROYAL_OWNER_PASSCODE   the passcode (at least 10 characters)
     ROYAL_SESSION_SECRET   a long random string used to sign sessions (at least 32 characters)
     ROYAL_SESSION_DAYS     how long a sign-in lasts, default 30 */

const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
async function sha(s) { return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(s)))); }
function same(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }

export function passcodeAuth({ passcode, secret, days = 30, clock = () => Date.now() }) {
  const configured = typeof passcode === "string" && passcode.length >= 10 && typeof secret === "string" && secret.length >= 32;
  const attempts = new Map(); /* who -> [timestamps] */
  /* Every wrong passcode from anywhere, so guessing from many addresses is
     limited too: 30 in 15 minutes and sign-in pauses for everyone. */
  let allWrong = [];

  return {
    configured,

    /* Returns {ok, token, expires_at} or {ok:false, status, error, message}. */
    async login(given, who = "anon") {
      if (!configured) return { ok: false, status: 503, error: "PASSCODE_NOT_CONFIGURED",
        message: "ROYAL's passcode is not set up on the server. Add ROYAL_OWNER_PASSCODE and ROYAL_SESSION_SECRET in Render." };
      const now = clock(), window = 15 * 60000;
      const recent = (attempts.get(who) || []).filter((t) => now - t < window);
      allWrong = allWrong.filter((t) => now - t < window);
      if (recent.length >= 5 || allWrong.length >= 30) return { ok: false, status: 429, error: "TOO_MANY_ATTEMPTS", message: "Too many wrong passcodes. Wait 15 minutes." };
      const good = same(await sha(given), await sha(passcode));
      if (!good) {
        recent.push(now); attempts.set(who, recent); allWrong.push(now);
        /* Forget only addresses whose attempts have all expired; never clear
           the lot, which would let a flood of addresses reset the limit. */
        if (attempts.size > 1000) for (const [k, v] of attempts) if (!v.some((t) => now - t < window)) attempts.delete(k);
        return { ok: false, status: 401, error: "WRONG_PASSCODE", message: "That passcode is not right." };
      }
      attempts.delete(who);
      const payload = b64u(enc.encode(JSON.stringify({ sub: "owner", iat: now, exp: now + days * 86400000 })));
      const sig = b64u(await hmac(secret, payload));
      return { ok: true, token: "rs1." + payload + "." + sig, expires_at: now + days * 86400000 };
    },

    /* A ROYAL session token -> {id, role} or null.  Anything else -> undefined
       (not ours; let the next auth method look at it). */
    async verify(token) {
      if (typeof token !== "string" || !token.startsWith("rs1.")) return undefined;
      if (!configured) return null;
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      let expect;
      try { expect = await hmac(secret, parts[1]); } catch { return null; }
      let got; try { got = fromB64u(parts[2]); } catch { return null; }
      if (!same(got, expect)) return null;
      let p; try { p = JSON.parse(new TextDecoder().decode(fromB64u(parts[1]))); } catch { return null; }
      if (!p || p.sub !== "owner" || !(p.exp > clock())) return null;
      return { id: "owner", role: "owner", via: "passcode" };
    },
  };
}
