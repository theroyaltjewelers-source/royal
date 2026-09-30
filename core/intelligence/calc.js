/* Deterministic calculation.  Arithmetic is never done by a model in prose.

   A small recursive-descent parser over + - * / ^ ( ) and numbers written
   the way people say them ($85,000, 12%, 1.5k, 2m).  "X% of Y" and the words
   plus, minus, times, divided by, percent are understood.  No eval, no
   variables, no function calls: the input can only ever be arithmetic. */

const WORDS = [
  [/\bdivided by\b/gi, "/"], [/\bmultiplied by\b/gi, "*"], [/\btimes\b/gi, "*"], [/\bplus\b/gi, "+"], [/\bminus\b/gi, "-"],
  [/\bpercent\b/gi, "%"], [/\bover\b/gi, "/"], [/[×x](?=\s*[\d($])/g, "*"], [/÷/g, "/"],
];

export function extractExpression(text) {
  let t = " " + String(text || "").toLowerCase() + " ";
  t = t.replace(/^\s*(what('?s| is)|how much is|calculate|compute|work out|whats)\s+/i, " ").replace(/[?=!]+\s*$/, " ");
  for (const [re, v] of WORDS) t = t.replace(re, v);
  /* "12% of 85,000" -> "(12/100)*85000" */
  t = t.replace(/(\d[\d,.]*\s*[km]?)\s*%\s*of\s*(?=\$?\d)/g, "($1/100)*");
  const m = /[-(\d$.][\d\s$,.%kmKM+\-*/^()]*[\d)%km]/.exec(t);
  if (!m) return null;
  const expr = m[0].trim();
  if (!/\d/.test(expr) || !/[+\-*/^%]/.test(expr.replace(/^-/, ""))) return null;
  return expr;
}

function tokenize(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s|\$|,/.test(c)) { i++; continue; }
    if (/[\d.]/.test(c)) {
      let j = i; while (j < s.length && /[\d.,]/.test(s[j])) j++;
      let v = Number(s.slice(i, j).replace(/,/g, ""));
      if (!isFinite(v)) throw new Error("BAD_NUMBER");
      let k = j; while (k < s.length && s[k] === " ") k++;
      if (/[kK]/.test(s[k] || "") && !/[a-z]/i.test(s[k + 1] || "")) { v *= 1e3; k++; j = k; }
      else if (/[mM]/.test(s[k] || "") && !/[a-z]/i.test(s[k + 1] || "")) { v *= 1e6; k++; j = k; }
      out.push({ t: "n", v }); i = j; continue;
    }
    if ("+-*/^()%".indexOf(c) >= 0) { out.push({ t: c }); i++; continue; }
    throw new Error("UNEXPECTED " + c);
  }
  return out;
}

export function evaluate(expr) {
  const toks = tokenize(String(expr));
  if (toks.length > 200) throw new Error("TOO_LONG");
  let p = 0;
  const peek = () => toks[p], eat = (t) => { if (!toks[p] || toks[p].t !== t) throw new Error("EXPECTED " + t); p++; };
  function primary() {
    const k = peek();
    if (!k) throw new Error("UNEXPECTED_END");
    if (k.t === "n") { p++; return postfix(k.v); }
    if (k.t === "(") { p++; const v = sum(); eat(")"); return postfix(v); }
    if (k.t === "-") { p++; return -primary(); }
    if (k.t === "+") { p++; return primary(); }
    throw new Error("UNEXPECTED " + k.t);
  }
  function postfix(v) { while (peek() && peek().t === "%") { p++; v = v / 100; } return v; }
  function power() { let b = primary(); if (peek() && peek().t === "^") { p++; b = Math.pow(b, power()); } return b; }
  function product() {
    let v = power();
    while (peek() && (peek().t === "*" || peek().t === "/")) {
      const op = toks[p++].t, r = power();
      if (op === "/" && r === 0) throw new Error("DIVIDE_BY_ZERO");
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }
  function sum() {
    let v = product();
    while (peek() && (peek().t === "+" || peek().t === "-")) { const op = toks[p++].t, r = product(); v = op === "+" ? v + r : v - r; }
    return v;
  }
  const v = sum();
  if (p !== toks.length) throw new Error("TRAILING_INPUT");
  if (!isFinite(v)) throw new Error("NOT_FINITE");
  return v;
}

export function calculate(text) {
  const expr = extractExpression(text);
  if (!expr) return { ok: false, failed_because: "NO_ARITHMETIC_FOUND" };
  try {
    const value = evaluate(expr);
    const money = /\$/.test(String(text));
    const rounded = Math.round(value * 1e6) / 1e6;
    const formatted = money ? (rounded < 0 ? "-$" : "$") + Math.abs(rounded).toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(rounded) ? 0 : 2, maximumFractionDigits: 2 })
      : rounded.toLocaleString("en-US", { maximumFractionDigits: 6 });
    return { ok: true, value: rounded, formatted, expression: expr };
  } catch (e) { return { ok: false, failed_because: "CANNOT_EVALUATE", detail: e.message, expression: expr }; }
}

export function looksArithmetic(text) {
  const t = String(text || "");
  /* "20% of 85,000" is arithmetic; "20% of what Marcus owes" is a House question. */
  return /\d/.test(t) && (/\d\s*(%|percent)\s*of\s*\$?\d/i.test(t) || /\d[\d,.]*\s*[k$m]?\s*([+\-*/^×÷]|plus|minus|times|divided by|multiplied by)\s*\$?\d/i.test(t)) && !!extractExpression(t);
}
