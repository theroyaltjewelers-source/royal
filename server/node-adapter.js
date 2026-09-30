/* node:http <-> fetch Request/Response.  Bodies are streamed, not buffered, so
   Server-Sent Events reach the browser as they are written; a client that
   goes away aborts the request, which closes its stream. */
const tooLarge = (res) => { res.writeHead(413, { "Content-Type": "application/json", Connection: "close" }); res.end(JSON.stringify({ ok: false, error: "BODY_TOO_LARGE" })); };

export function nodeAdapter(handler, { maxBody = 5 * 1024 * 1024 } = {}) {
  return async (req, res) => {
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    try {
      /* Bodies are capped while they are read, before sign-in is checked, so
         nobody can fill the server's memory with an upload. */
      if (Number(req.headers["content-length"] || 0) > maxBody) { tooLarge(res); req.destroy(); return; }
      const chunks = []; let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > maxBody) { tooLarge(res); req.destroy(); return; }
        chunks.push(c);
      }
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const request = new Request("http://" + (req.headers.host || "localhost") + req.url, {
        method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body, signal: ac.signal });
      const r = await handler(request);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      if (!r.body) return res.end();
      if (/^text\/event-stream/.test(r.headers.get("content-type") || "")) {
        res.flushHeaders(); req.socket.setNoDelay(true); req.socket.setKeepAlive(true);
        const reader = r.body.getReader();
        ac.signal.addEventListener("abort", () => reader.cancel().catch(() => {}), { once: true });
        for (;;) {
          const { value, done } = await reader.read();
          if (done || res.destroyed) break;
          if (!res.write(value)) await new Promise((ok) => {
            const done = () => { res.off("drain", done); res.off("close", done); ok(); };
            res.on("drain", done); res.on("close", done);
          });
        }
        return res.end();
      }
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch (_) {} return; }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "SERVER_ERROR" }));
    }
  };
}
