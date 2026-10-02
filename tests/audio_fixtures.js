/* Synthetic audio for the voice engine tests, at 16 kHz.  Not recordings:
   signals with the properties the detector relies on, so its behaviour is
   tested against each property on its own.
     speech     voiced harmonics on a pitch, loudness rising and falling with
                syllables (about 4.5 a second)
     hvac       steady low rumble
     hiss       steady broadband noise (microphone hiss, a fan)
     pad        a steady musical chord (sustained music)
     room       a very quiet room                                          */

export const SR = 16000, FRAME = SR / 50;
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
const amp = (dbfs) => Math.pow(10, dbfs / 20);

export function speech(ms, { dbfs = -20, f0 = 140, rate = 4.5 } = {}) {
  const n = Math.round(SR * ms / 1000), out = new Float32Array(n), a = amp(dbfs) * 0.5;
  for (let i = 0; i < n; i++) {
    const t = i / SR, f = f0 * (1 + 0.06 * Math.sin(2 * Math.PI * 0.7 * t));
    let v = 0; for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * f * h * t) / h;
    /* syllables, and a short gap between words every 0.6 s */
    const word = (t % 0.6) > 0.53 ? 0.04 : 1;
    const env = word * (0.3 + 0.7 * Math.abs(Math.sin(Math.PI * rate * t)));
    out[i] = a * env * v + 0.004 * a * rnd();
  }
  return out;
}
export function room(ms, dbfs = -62) { const n = Math.round(SR * ms / 1000), o = new Float32Array(n), a = amp(dbfs); for (let i = 0; i < n; i++) o[i] = a * rnd(); return o; }
export function hiss(ms, dbfs = -38) { return room(ms, dbfs); }
export function hvac(ms, dbfs = -40) {
  const n = Math.round(SR * ms / 1000), o = new Float32Array(n), a = amp(dbfs) * 2.2; let y = 0;
  for (let i = 0; i < n; i++) { y = 0.9 * y + 0.1 * rnd(); o[i] = a * y + 0.25 * amp(dbfs) * Math.sin(2 * Math.PI * 60 * i / SR); }
  return o;
}
export function pad(ms, dbfs = -28) {
  const n = Math.round(SR * ms / 1000), o = new Float32Array(n), a = amp(dbfs) * 0.35;
  for (let i = 0; i < n; i++) { const t = i / SR; o[i] = a * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277 * t) + Math.sin(2 * Math.PI * 330 * t)); }
  return o;
}
export function mix(...xs) { const n = Math.max(...xs.map((x) => x.length)), o = new Float32Array(n); for (const x of xs) for (let i = 0; i < x.length; i++) o[i] += x[i]; return o; }
export function concat(...xs) { const n = xs.reduce((a, x) => a + x.length, 0), o = new Float32Array(n); let p = 0; for (const x of xs) { o.set(x, p); p += x.length; } return o; }
export function frames(sig) { const out = []; for (let i = 0; i + FRAME <= sig.length; i += FRAME) out.push(sig.subarray(i, i + FRAME)); return out; }
