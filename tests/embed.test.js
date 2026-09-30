/* The embed client, run in a stand-in window against the real handler. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";
import { createHandler } from "../server/handler.js";
import { createRoyal } from "../core/royal.js";
import { MemoryStore } from "../core/store.js";
import { house } from "./fixtures.js";

const SRC = readFileSync(new URL("../web/royal-embed.js", import.meta.url), "utf8");

function sandbox(handler, token = "t-owner") {
  const window = {};
  const fetch = (url, o) => handler(new Request(url, o));
  vm.runInNewContext(SRC, { window, fetch, setTimeout, clearTimeout, Promise, JSON, String });
  return { E: window.ROYALEmbed, token };
}
function server() {
  const royal = createRoyal({ store: new MemoryStore() });
  const handler = createHandler({ royal, auth: async (t) => (t === "t-owner" ? { id: "u", role: "owner" } : null) });
  return { royal, handler };
}
const tick = () => new Promise((r) => setTimeout(r, 30));

test("embed pushes the host's snapshot and reports CONNECTED", async () => {
  const { royal, handler } = server();
  const { E } = sandbox(handler);
  const seen = []; E.onStatus((s) => seen.push(s));
  assert.equal(E.init({ api: "https://royal.test", getToken: () => "t-owner", getSnapshot: () => house() }), true);
  await tick();
  assert.equal(E.status(), "CONNECTED"); assert.ok((await royal.connector.latest()), "snapshot reached ROYAL");
});

test("embed with no address stays off, and a bad token never reports connected", async () => {
  const { handler } = server();
  const off = sandbox(handler).E;
  assert.equal(off.init({ api: "", getToken: () => "x", getSnapshot: () => house() }), false);
  const bad = sandbox(handler).E;
  bad.init({ api: "https://royal.test", getToken: () => "forged", getSnapshot: () => house() });
  await tick();
  assert.notEqual(bad.status(), "CONNECTED");
});

test("embed asks ROYAL and renders escaped HTML", async () => {
  const { handler } = server();
  const { E } = sandbox(handler);
  const evil = house(); evil.projects[0].name = "<img src=x onerror=alert(1)>";
  E.init({ api: "https://royal.test", getToken: () => "t-owner", getSnapshot: () => evil });
  await tick();
  const r = await E.ask("What needs me?");
  const html = E.render(r);
  assert.ok(html.indexOf("<img") < 0, "HTML from records is escaped");
  assert.match(html, /rimsg royal/);
});

test("the calculator ships an identical copy of the embed client", { skip: process.env.RTJ_CALCULATOR_DIR ? false : "set RTJ_CALCULATOR_DIR" }, () => {
  const p = process.env.RTJ_CALCULATOR_DIR + "/unified/royal-embed.js";
  assert.ok(existsSync(p), "calculator is missing royal-embed.js");
  assert.equal(readFileSync(p, "utf8"), SRC, "the calculator's copy has drifted from ROYAL's");
});
