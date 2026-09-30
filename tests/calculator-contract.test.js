/* The contract between the calculator and ROYAL, checked against the real
   calculator.  Runs when RTJ_CALCULATOR_DIR points at a calculator checkout
   (with its node_modules installed); skipped otherwise, and says so.

   It loads the shipped calculator page headlessly, seeds a house, calls the
   House API, and asserts that what comes out is exactly what ROYAL accepts
   and can reason over.  If the calculator's House API drifts, this fails. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { validateSnapshot } from "../realms/business/royal-t/contract.js";
import { createRoyal } from "../core/royal.js";
import { MemoryStore } from "../core/store.js";

const DIR = process.env.RTJ_CALCULATOR_DIR;
const SEED = process.env.RTJ_SEED || "/tmp/seed.js";
const ready = DIR && existsSync(join(DIR, "unified", "index.html")) && existsSync(join(DIR, "node_modules", "playwright")) && existsSync(SEED);

test("calculator House API satisfies the ROYAL contract", { skip: ready ? false : "set RTJ_CALCULATOR_DIR to a calculator checkout with node_modules, and RTJ_SEED to a seed" }, async () => {
  const req = createRequire(join(DIR, "package.json"));
  const { chromium } = req("playwright");
  execFileSync(process.execPath, [join(DIR, "tests", "instrument.js")]);
  const out = join(DIR, "unified", "__contract.html");
  const fs = await import("node:fs");
  fs.writeFileSync(out, readFileSync(join((await import("node:os")).tmpdir(), "rtj-instrumented.html"), "utf8"));
  const seed = createRequire(import.meta.url)(SEED);
  const b = await chromium.launch({ executablePath: process.env.RTJ_CHROMIUM || "/opt/pw-browsers/chromium" });
  let snap, errors = [];
  try {
    const p = await b.newPage();
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto("file://" + out); await p.waitForTimeout(600);
    await p.evaluate(seed);
    snap = await p.evaluate(() => window.RTJ_HOUSE && window.RTJ_HOUSE.snapshot());
    const frozen = await p.evaluate(() => { try { window.RTJ_HOUSE.snapshot = null; } catch (e) { return true; } return window.RTJ_HOUSE.snapshot !== null; });
    assert.equal(frozen, true, "the House API object is frozen");
  } finally { await b.close(); fs.unlinkSync(out); }

  assert.deepEqual(errors, []);
  assert.ok(snap, "window.RTJ_HOUSE.snapshot() returned nothing");
  const v = validateSnapshot(snap);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.ok(snap.projects.length >= 20, "seeded projects came through");
  const coded = snap.projects.flatMap((x) => x.attention).filter((a) => a.code);
  assert.ok(coded.length > 0 && coded.every((a) => /^[A-Z_]+$/.test(a.code)), "attention items carry machine codes");
  const txt = JSON.stringify(snap);
  assert.ok(!/@example\.com/.test(txt), "no client email addresses leave the calculator");
  assert.ok(!/landed|manufacturer name|internal note/i.test(Object.keys(snap.projects[0]).join(" ")), "no internal economics field names");

  const royal = createRoyal({ store: new MemoryStore() });
  assert.equal((await royal.ingestCalculator(snap)).ok, true);
  for (const q of ["What needs me?", "State of the House", "Who owes us money?", "Can I step away?", "What are we waiting on?"]) {
    const a = await royal.handle({ content: q });
    assert.notEqual(a.status, "FAILED", q + ": " + a.summary);
    assert.notEqual(a.status, "NOT_CONNECTED", q);
  }
});
