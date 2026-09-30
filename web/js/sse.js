/* An authenticated Server-Sent Events reader.

   The browser's EventSource cannot send an Authorization header, and ROYAL's
   token must never go in a URL (it would end up in logs).  So this reads the
   stream with fetch(), parses the event format itself, reconnects with
   backoff, and resumes with Last-Event-ID so nothing is missed or repeated. */

export function openStream(url, { token, since = null, onEvent, onHello, onStatus, onReset } = {}) {
  let lastId = since, stopped = false, backoff = 1000, ctrl = null;
  const status = (s) => { try { onStatus && onStatus(s); } catch (_) {} };

  async function run() {
    while (!stopped) {
      ctrl = new AbortController();
      try {
        status("connecting");
        const r = await fetch(url, { headers: { Authorization: "Bearer " + token(), Accept: "text/event-stream", ...(lastId ? { "Last-Event-ID": String(lastId) } : {}) },
          cache: "no-store", signal: ctrl.signal });
        if (r.status === 401) { status("signed_out"); return; }
        if (r.status === 400 || r.status === 403 || r.status === 404) { status("forbidden"); return; }
        if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
        status("live"); backoff = 1000;
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf = (buf + value).replace(/\r\n/g, "\n");
          let cut;
          while ((cut = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, cut); buf = buf.slice(cut + 2);
            let event = "message", data = "", id = null;
            for (const line of block.split("\n")) {
              if (!line || line[0] === ":") continue;
              const i = line.indexOf(":"), f = i < 0 ? line : line.slice(0, i), v = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
              if (f === "event") event = v; else if (f === "data") data += (data ? "\n" : "") + v; else if (f === "id") id = v;
            }
            if (event === "reset") { stopped = true; if (onReset) onReset(); return; }   /* the server can't replay the gap: reload */
            if (!data) continue;
            let payload; try { payload = JSON.parse(data); } catch (_) { continue; }
            if (id) lastId = id;
            if (event === "hello") onHello && onHello(payload);
            else if (event === "bot_event") onEvent && onEvent(payload);
          }
        }
      } catch (_) { if (stopped) return; }
      if (stopped) return;
      status("reconnecting");
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }
  run();
  return { close() { stopped = true; if (ctrl) ctrl.abort(); }, get lastId() { return lastId; } };
}
