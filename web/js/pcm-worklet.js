/* Microphone capture for realtime voice: hands 20 ms mono frames of the raw
   signal to the page, which converts them to 24 kHz PCM16.  Runs in the
   audio thread; holds nothing. */
class RoyalPcm extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.size = 0; this.frame = Math.round(sampleRate / 50); }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      this.buf.push(ch.slice(0)); this.size += ch.length;
      if (this.size >= this.frame) {
        const out = new Float32Array(this.size); let o = 0;
        for (const b of this.buf) { out.set(b, o); o += b.length; }
        this.port.postMessage(out, [out.buffer]); this.buf = []; this.size = 0;
      }
    }
    return true;
  }
}
registerProcessor("royal-pcm", RoyalPcm);
