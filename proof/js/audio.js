/* Sound, off until asked for. Thirty-five voices, one per validator, tuned
 * across a pentatonic scale; each sounds when that validator's signature is
 * checked. The chord only resolves when the quorum signs the same ledger. */
const SCALE = [0, 2, 4, 7, 9];

export class Sound {
  constructor() { this.ctx = null; this.on = false; }
  enable() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.out = this.ctx.createGain(); this.out.gain.value = 0.32;
      const verb = this.ctx.createConvolver();
      verb.buffer = this.impulse(2.4);
      const wet = this.ctx.createGain(); wet.gain.value = 0.28;
      this.out.connect(this.ctx.destination);
      this.out.connect(verb); verb.connect(wet); wet.connect(this.ctx.destination);
    }
    this.ctx.resume();
    this.on = true;
  }
  disable() { this.on = false; }
  impulse(sec) {
    const n = this.ctx.sampleRate * sec, b = this.ctx.createBuffer(2, n, this.ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 3;
    }
    return b;
  }
  freq(i) {
    const oct = Math.floor(i / 5), deg = SCALE[i % 5];
    return 196 * 2 ** ((oct * 12 + deg) / 12);
  }
  tone(f, t0, dur, gain, type = 'sine') {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.out);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  /** One validator's signature checked: a short plucked note. */
  pluck(i) {
    if (!this.on) return;
    const t = this.ctx.currentTime;
    this.tone(this.freq(i), t, 0.9, 0.05, 'triangle');
    this.tone(this.freq(i) * 2, t, 0.35, 0.012);
  }
  /** Quorum: the chord resolves, and the press comes down. */
  quorum() {
    if (!this.on) return;
    const t = this.ctx.currentTime;
    [0, 4, 7, 12].forEach((s, k) => this.tone(130.8 * 2 ** (s / 12), t + k * 0.02, 2.6, 0.045));
    const c = this.ctx, n = c.createBufferSource(), g = c.createGain(), f = c.createBiquadFilter();
    const buf = c.createBuffer(1, c.sampleRate * 0.25, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 6;
    n.buffer = buf; f.type = 'lowpass'; f.frequency.value = 320;
    g.gain.value = 0.5; n.connect(f); f.connect(g); g.connect(this.out); n.start(t);
  }
  /** The header hashes to what they signed: a small bell. */
  bell() {
    if (!this.on) return;
    const t = this.ctx.currentTime + 0.05;
    this.tone(1046.5, t, 2.2, 0.03);
    this.tone(1046.5 * 2.76, t, 1.1, 0.008);
  }
  /** An account's entry hashes up to the state root: the lantern is lit. */
  chime() {
    if (!this.on) return;
    const t = this.ctx.currentTime + 0.05;
    this.tone(1568, t, 1.4, 0.02);
    this.tone(2093, t + 0.12, 1.8, 0.016);
  }
  /** Quieter while the tour's narrator speaks. */
  duck(on) {
    if (!this.out) return;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(on ? 0.08 : 0.32, t, 0.25);
  }
  /** A refusal: the header is not the ledger the quorum signed. */
  thud() {
    if (!this.on) return;
    const t = this.ctx.currentTime;
    this.tone(98, t, 0.5, 0.08, 'sine');
  }
}
