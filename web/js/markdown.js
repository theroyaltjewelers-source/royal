/* A small, safe Markdown renderer for bot messages.

   Everything is escaped first, so no HTML a bot sends can ever become markup.
   Then a fixed set of Markdown forms is turned into a fixed set of tags:
   paragraphs, headings, bold, italic, inline code, code blocks, lists, block
   quotes, rules, and links to http(s) addresses only (opened in a new tab,
   without referrer).  Anything else stays as plain text. */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function inline(t) {
  /* t is already escaped */
  const codes = [];
  t = t.replace(/`([^`\n]{1,500})`/g, (_, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
  t = t.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2000})\)/g, (_, label, href) =>
    '<a href="' + href.replace(/"/g, "&quot;") + '" target="_blank" rel="noopener noreferrer nofollow">' + label + "</a>");
  t = t.replace(/\*\*([^*\n]{1,1000})\*\*/g, "<strong>$1</strong>").replace(/__([^_\n]{1,1000})__/g, "<strong>$1</strong>");
  t = t.replace(/(^|[\s(])\*([^*\n]{1,1000})\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>").replace(/(^|[\s(])_([^_\n]{1,1000})_(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => "<code>" + codes[Number(i)] + "</code>");
}

export function renderMarkdown(src, { maxChars = 100000 } = {}) {
  const lines = esc(String(src == null ? "" : src).slice(0, maxChars)).replace(/\r\n?/g, "\n").split("\n");
  const out = []; let para = [], list = null, quote = [];
  const flushPara = () => { if (para.length) { out.push("<p>" + inline(para.join("<br>")) + "</p>"); para = []; } };
  const flushList = () => { if (list) { out.push("<" + list.tag + ">" + list.items.map((i) => "<li>" + inline(i) + "</li>").join("") + "</" + list.tag + ">"); list = null; } };
  const flushQuote = () => { if (quote.length) { out.push("<blockquote>" + inline(quote.join("<br>")) + "</blockquote>"); quote = []; } };
  const flush = () => { flushPara(); flushList(); flushQuote(); };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^```/.test(l)) {
      flush(); const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      out.push("<pre><code>" + code.join("\n") + "</code></pre>"); continue;
    }
    let m;
    if ((m = /^(#{1,4})\s+(.+)$/.exec(l))) { flush(); const n = Math.min(6, m[1].length + 2); out.push("<h" + n + ">" + inline(m[2]) + "</h" + n + ">"); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out.push("<hr>"); continue; }
    if ((m = /^\s*[-*+]\s+(.+)$/.exec(l))) { flushPara(); flushQuote(); if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; } list.items.push(m[1]); continue; }
    if ((m = /^\s*\d{1,3}[.)]\s+(.+)$/.exec(l))) { flushPara(); flushQuote(); if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; } list.items.push(m[1]); continue; }
    if ((m = /^&gt;\s?(.*)$/.exec(l))) { flushPara(); flushList(); quote.push(m[1]); continue; }
    if (!l.trim()) { flush(); continue; }
    flushList(); flushQuote(); para.push(l);
  }
  flush();
  return out.join("");
}
