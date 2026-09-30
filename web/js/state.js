/* The ROYAL state machine.  Every state has a fixed visual meaning, carried
   by the numbers below; the Core renderer eases toward them.  Nothing here
   is random: the same state always looks the same.

     energy     overall luminosity of the core
     scale      size of the core relative to its resting size
     speed      rate of internal movement
     coherence  how ordered the plasma is (1 = calm, 0 = turbulent)
     corona     reach of the corona (contraction below 1)
     converge   particles drawn inward (understanding)
     reach      energy paths extending outward (retrieving, delegating, acting)
     warm       amber introduced (attention); crit = restrained red
     dim        dormant */

export const STATES = {
  OFFLINE:              { energy: 0.18, scale: 0.86, speed: 0.10, coherence: 1.00, corona: 0.55, converge: 0.0, reach: 0.0, warm: 0.0, crit: 0.0, dim: 1.0 },
  AMBIENT:              { energy: 0.62, scale: 1.00, speed: 0.22, coherence: 0.92, corona: 1.00, converge: 0.0, reach: 0.0, warm: 0.0, crit: 0.0, dim: 0.0 },
  AWAKE:                { energy: 0.82, scale: 1.06, speed: 0.34, coherence: 0.97, corona: 0.92, converge: 0.0, reach: 0.0, warm: 0.0, crit: 0.0, dim: 0.0 },
  LISTENING:            { energy: 0.88, scale: 1.04, speed: 0.40, coherence: 0.90, corona: 0.96, converge: 0.0, reach: 0.0, warm: 0.0, crit: 0.0, dim: 0.0 },
  UNDERSTANDING:        { energy: 0.92, scale: 0.96, speed: 0.55, coherence: 0.95, corona: 0.80, converge: 1.0, reach: 0.0, warm: 0.0, crit: 0.0, dim: 0.0 },
  THINKING:             { energy: 0.96, scale: 0.98, speed: 0.95, coherence: 0.80, corona: 0.88, converge: 0.4, reach: 0.0, warm: 0.0, crit: 0.0, dim: 0.0 },
  RETRIEVING:           { energy: 0.94, scale: 1.00, speed: 0.80, coherence: 0.85, corona: 1.05, converge: 0.0, reach: 0.7, warm: 0.0, crit: 0.0, dim: 0.0 },
  DELEGATING:           { energy: 0.98, scale: 1.00, speed: 0.85, coherence: 0.88, corona: 1.10, converge: 0.0, reach: 1.0, warm: 0.0, crit: 0.0, dim: 0.0 },
  ACTING:               { energy: 1.00, scale: 1.02, speed: 1.00, coherence: 0.90, corona: 1.15, converge: 0.0, reach: 1.0, warm: 0.0, crit: 0.0, dim: 0.0 },
  WAITING_FOR_APPROVAL: { energy: 0.74, scale: 1.00, speed: 0.12, coherence: 1.00, corona: 0.90, converge: 0.0, reach: 0.0, warm: 0.35, crit: 0.0, dim: 0.0 },
  RESPONDING:           { energy: 0.90, scale: 1.02, speed: 0.45, coherence: 0.94, corona: 1.00, converge: 0.0, reach: 0.0, warm: 0.0, crit: 0.0, dim: 0.0 },
  COMPLETE:             { energy: 1.00, scale: 0.98, speed: 0.30, coherence: 1.00, corona: 0.85, converge: 0.6, reach: 0.0, warm: 0.0, crit: 0.0, dim: 0.0 },
  WARNING:              { energy: 0.84, scale: 1.00, speed: 0.35, coherence: 0.90, corona: 1.00, converge: 0.0, reach: 0.0, warm: 0.85, crit: 0.0, dim: 0.0 },
  FAILURE:              { energy: 0.50, scale: 0.94, speed: 0.18, coherence: 0.96, corona: 0.70, converge: 0.0, reach: 0.0, warm: 0.2, crit: 0.55, dim: 0.2 },
};

/* Legal transitions.  Anything else is a bug and is refused (and logged),
   so the Core can never show a state the system is not in. */
const ANY = Object.keys(STATES);
export const TRANSITIONS = {
  OFFLINE: ["AMBIENT", "AWAKE", "OFFLINE"],
  AMBIENT: ["AWAKE", "LISTENING", "UNDERSTANDING", "OFFLINE", "WARNING", "WAITING_FOR_APPROVAL", "AMBIENT"],
  AWAKE: ANY, LISTENING: ANY, UNDERSTANDING: ANY, THINKING: ANY, RETRIEVING: ANY, DELEGATING: ANY, ACTING: ANY,
  WAITING_FOR_APPROVAL: ANY, RESPONDING: ANY, COMPLETE: ANY, WARNING: ANY, FAILURE: ANY,
};

export const LABELS = {
  OFFLINE: "Offline", AMBIENT: "Present", AWAKE: "Awake", LISTENING: "Listening", UNDERSTANDING: "Understanding",
  THINKING: "Thinking", RETRIEVING: "Retrieving", DELEGATING: "Consulting specialists", ACTING: "Acting",
  WAITING_FOR_APPROVAL: "Waiting for your decision", RESPONDING: "Responding", COMPLETE: "Done", WARNING: "Needs attention", FAILURE: "Could not complete",
};

export class RoyalState {
  constructor(initial = "AMBIENT") { this.state = initial; this.listeners = []; this.history = [initial]; }
  on(fn) { this.listeners.push(fn); }
  go(next, why = "") {
    if (!STATES[next]) { console.warn("ROYAL state: unknown", next); return false; }
    if ((TRANSITIONS[this.state] || []).indexOf(next) < 0) { console.warn("ROYAL state: refused", this.state, "->", next, why); return false; }
    const prev = this.state; this.state = next;
    this.history.push(next); if (this.history.length > 50) this.history.shift();
    this.listeners.forEach((f) => { try { f(next, prev, why); } catch (e) { console.error(e); } });
    return true;
  }
  params() { return STATES[this.state]; }
}
