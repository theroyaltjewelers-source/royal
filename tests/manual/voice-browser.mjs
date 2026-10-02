/* The voice engine in a real browser, hands free.  Not part of `npm test`
   (it needs Playwright and Chromium, which ROYAL does not depend on).

     PORT=8799 ROYAL_DEV_OWNER_TOKEN=devtoken-123456 node server/node.js &
     node tests/manual/voice-browser.mjs [phone|desktop] [long]

   Chromium's fake microphone plays a looping synthetic voice (a quiet room,
   a 1.8 s question, a gap).  Transcription and ROYAL's spoken voice are
   stubbed at the network (the server here has no xAI key), so the test
   exercises the real microphone, worklet, detector, turn logic, state
   machine, /v1/command and page.  "long" makes each spoken answer 6 s, so
   the next question interrupts it (barge-in); otherwise answers are 1.5 s
   and ROYAL must listen again on her own after each.  One touch, then 45 s
   with no touch; it prints the state trail, each turn, and the diagnostics.
   VOICE_REDUCED=1 emulates reduced motion; VOICE_NOWEBGL=1 turns WebGL off;
   VOICE_SECS sets how long to run (default 45). */

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import * as A from "../audio_fixtures.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PW = join(execSync("npm root -g").toString().trim(), "playwright");
const { chromium } = createRequire(PW + "/")(PW);
const URL_ = process.env.ROYAL_URL || "http://localhost:8799", TOKEN = process.env.ROYAL_TOKEN || "devtoken-123456";
const dir = mkdtempSync(join(tmpdir(), "royal-voice-"));
const wav = (sig, rate) => { const b = Buffer.alloc(44 + sig.length * 2); b.write("RIFF", 0); b.writeUInt32LE(36 + sig.length * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(sig.length * 2, 40);
  for (let i = 0; i < sig.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sig[i] * 32767))), 44 + i * 2); return b; };
writeFileSync(join(dir, "mic.wav"), wav(A.concat(A.room(1500, -60), A.speech(1800, { dbfs: -18 }), A.room(2500, -60)), 16000));
const secs = process.argv[3] === "long" ? 6 : 1.5, tone = new Float32Array(24000 * secs);
for (let i = 0; i < tone.length; i++) tone[i] = 0.05 * Math.sin(2 * Math.PI * 220 * i / 24000);
const royal = wav(tone, 24000);

const vp = process.argv[2] === "phone" ? { width: 390, height: 844 } : { width: 1440, height: 900 };
const b = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--use-file-for-fake-audio-capture=" + join(dir, "mic.wav"), "--autoplay-policy=no-user-gesture-required", ...(process.env.VOICE_NOWEBGL ? ["--disable-webgl", "--disable-3d-apis"] : [])] });
const p = await b.newPage({ viewport: vp, reducedMotion: process.env.VOICE_REDUCED ? "reduce" : "no-preference" });
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
const said = ["What needs me today?", "Which ones are the strongest?", "No, Royal, that's not what I meant.", "Tell me about the pipeline.", "Thanks."];
let n = 0; const cmds = [];
await p.route("**/v1/intelligence/status", async (r) => { const j = await (await r.fetch()).json(); j.voice_transcription = "AVAILABLE"; j.spoken_voice = "AVAILABLE"; await r.fulfill({ json: j }); });
await p.route("**/v1/voice/transcribe**", (r) => r.fulfill({ json: { ok: true, text: said[n++ % said.length] } }));
await p.route("**/v1/voice/speak**", (r) => r.fulfill({ status: 200, headers: { "content-type": "audio/wav" }, body: royal }));
p.on("request", (q) => { if (q.url().includes("/v1/command")) cmds.push(JSON.parse(q.postData()).content); });
await p.goto(URL_ + "/?voicedebug=1#access_token=" + TOKEN);
await p.waitForTimeout(2000);
if (await p.isVisible("#boot")) { await p.click("#boot"); await p.waitForTimeout(900); }
const box = await p.evaluate(() => { const r = document.getElementById("wake").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
const t0 = Date.now(), trail = []; let last = "";
await p.mouse.click(box.x, box.y);
while (Date.now() - t0 < Number(process.env.VOICE_SECS || 45) * 1000) {
  const v = await p.evaluate(() => document.body.dataset.voice || "");
  if (v !== last) { trail.push(((Date.now() - t0) / 1000).toFixed(1) + "s " + v); last = v; }
  await p.waitForTimeout(100);
}
const d = JSON.parse(await p.textContent("#vdebug"));
console.log("trail:", trail.join(" | "));
console.log("sent to ROYAL:", JSON.stringify(cmds));
console.log("diag:", JSON.stringify({ mic: d.mic, transcriber: d.transcriber, turns: d.turns, barge_ins: d.barge_ins, discarded: d.discarded, latency_p50_ms: d.latency_p50_ms, errors: d.errors }));
console.log("render:", await p.evaluate(() => document.body.dataset.render), "reduced motion:", await p.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches));
console.log("page errors:", errs.filter((e) => !/fonts/.test(e)).length ? errs : "none");
await b.close();
