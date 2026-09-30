/* ROYAL's sound and touch language.  Original, synthesized in the browser,
   short and quiet.  Each cue means one thing; none repeats on its own.
   Off by default until the first touch (browsers require it), switchable
   off entirely, and silent when the system asks for reduced motion. */

const CUES = {
  wake:     [[392, 0.00, 0.16], [587, 0.07, 0.22]],
  listen:   [[523, 0.00, 0.08]],
  delegate: [[330, 0.00, 0.10], [440, 0.05, 0.10]],
  returned: [[440, 0.00, 0.10], [330, 0.05, 0.12]],
  approval: [[494, 0.00, 0.14], [494, 0.18, 0.14]],
  complete: [[523, 0.00, 0.18], [659, 0.04, 0.22], [784, 0.08, 0.26]],
  warning:  [[294, 0.00, 0.22]],
  failure:  [[220, 0.00, 0.20], [196, 0.12, 0.24]],
};
const BUZZ = { wake: [8], approval: [10, 60, 10], complete: [6], warning: [18] };

export class Sound {
  constructor() {
    this.enabled = (() => { try { return localStorage.getItem("royal.sound") !== "0"; } catch (_) { return true; } })();
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.ac = null;
  }
  setEnabled(v) { this.enabled = !!v; try { localStorage.setItem("royal.sound", v ? "1" : "0"); } catch (_) {} }
  /* Also wakes a context the browser suspended (a phone call, the app in the
     background), so the wake cue is not silently lost on the next touch. */
  unlock() { if (this.ac) { if (this.ac.state === "suspended" || this.ac.state === "interrupted") { try { const p = this.ac.resume(); if (p && p.catch) p.catch(() => {}); } catch (_) {} } return; } const AC = window.AudioContext || window.webkitAudioContext; if (AC) { try { this.ac = new AC(); } catch (_) { this.ac = null; } } }
  /* A very short tap the moment a finger presses the Core.  Only where the
     device can vibrate, never under reduced motion, and only once the page
     has been touched (browsers refuse vibration before that anyway). */
  tap() {
    if (this.reduced || !navigator.vibrate) return false;
    const ua = navigator.userActivation; if (ua && !ua.hasBeenActive) return false;
    try { navigator.vibrate(6); } catch (_) { return false; }
    this.tapAt = Date.now(); return true;
  }
  play(name) {
    /* the wake buzz right after a press tap would feel like a double knock */
    const justTapped = name === "wake" && Date.now() - (this.tapAt || 0) < 700;
    if (BUZZ[name] && navigator.vibrate && !this.reduced && !justTapped) { try { navigator.vibrate(BUZZ[name]); } catch (_) {} }
    if (!this.enabled || !this.ac || !CUES[name]) return;
    const t0 = this.ac.currentTime + 0.01;
    for (const [f, at, dur] of CUES[name]) {
      const o = this.ac.createOscillator(), g = this.ac.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + at); g.gain.linearRampToValueAtTime(0.045, t0 + at + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      o.connect(g); g.connect(this.ac.destination); o.start(t0 + at); o.stop(t0 + at + dur + 0.02);
    }
  }
}
