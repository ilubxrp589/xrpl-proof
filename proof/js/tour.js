/* The tour: the proof explained one numbered mark at a time. The camera
 * flies to each part of the sky while the page keeps checking, so every stop
 * points at something happening now, checked in this browser, rather than at
 * a picture of it. A narrator reads each stop (audio/<voice>/tour-<id>.mp3:
 * Kokoro-82M, rendered ahead of time; the scripts are written for the ear, so
 * they say less than the band and name no numbers that could change).
 *
 * It opens by itself on a first visit; "Tour" brings it back. */
import { KEY_AT, BODY_AT, lightAt } from './scene.js';

const SEEN = 'proof.toured';
const VOICE = 'proof.narrate';        // '0' once the visitor turns the narrator off
const WHO = 'proof.voice';            // which narrator: audio/<name>/tour-<stop>.mp3
const VOICES = ['heart', 'fenrir'];   // Kokoro af_heart and am_fenrir: the tour's two narrators
const GENESIS = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';   // the first account the ledger ever had
const fmt = n => Number(n).toLocaleString('en-US');
const out = (p, k) => [p[0] * k, p[1] * k, p[2]];

// Each stop flies to a sphere of the sky (`at`, radius `r`, seen from `yaw` and
// `pitch`) and sets its number at `mark`, a point in the sky (n: how many
// validators the list has). `names` shows who each light belongs to.
const STEPS = [
  { id: 'intro',
    title: () => 'A ledger, checked in your browser',
    body: () => 'Every few seconds the XRP Ledger’s validators agree on a new ledger and sign it. ' +
      'This page doesn’t take anyone’s word for it. It checks every signature itself, in your browser, and lights ' +
      'only what passed: light means checked here, an outline means someone else said so. ' +
      'The numbers mark the seven things to look at.',
    live: s => (s.seq ? `Ledger ${fmt(s.seq)} is in view now.` : 'Waiting for the next ledger to close…') },
  { id: 'key', name: 'the key', at: KEY_AT, r: 0.95, mark: () => KEY_AT,
    title: () => 'One key to steer by',
    body: s => 'Everything here is checked against a single key: the gold star. It belongs to ' +
      `${s.root}, which publishes the list of validators, and it is built into this page rather than fetched. ` +
      `After the tour you can trust ${s.other}’s key instead, in the list ${s.stacked ? 'below' : 'on the left'}.`,
    live: s => `The key: ${s.rootKey.slice(0, 12)}…${s.rootKey.slice(-8)}` },
  { id: 'list', name: 'the list', at: [0, 0.05, 0], r: 1.32, yaw: -0.22, pitch: 0.08, mark: n => out(lightAt(Math.round(n * 0.86), n), 1.28),
    title: () => 'The gate is the list',
    body: s => `That key signed a list of ${s.total} validators, and your browser checks that signature before ` +
      'anything else, along with each validator’s word for the key it signs with today. Only then is the gate ' +
      'drawn: one light for each validator on the list.',
    live: s => `Checked in this browser: the list’s signature, and the keys of all ${s.total} validators.` },
  { id: 'sigs', name: 'the signatures', at: [0.78, 0.3, 0.05], r: 0.62, yaw: -0.3, pitch: 0.06, mark: n => out(lightAt(Math.round(n * 0.2), n), 1.46),
    title: s => `${s.total} lights, ${s.total} validators`,
    body: () => 'Each validator signs every ledger. When your browser has checked one validator’s signature on the ' +
      'ledger in view, its light comes on. The lines beyond it are its spectrum, set by the bytes of that very ' +
      'signature, so they change with every ledger.',
    live: (s, e) => (!s.seq ? 'Waiting for the next ledger…'
      : s.count >= s.total ? `Ledger ${fmt(s.seq)}: all ${s.total} checked.`
      : `Ledger ${fmt(s.seq)}: ${s.count} of ${s.total} checked so far${e.signed ? `, the latest from ${e.signed}` : ''}.`) },
  { id: 'quorum', name: 'the quorum', at: [0, 0, 0], r: 1.02, yaw: -0.14, pitch: 0.05, mark: () => [-0.52, 0.44, 0.03],
    title: s => `${s.quorum} of ${s.total} open the horizon`,
    body: s => `Once ${s.quorum} of the ${s.total} have signed the same ledger, that is a quorum: the network has ` +
      'accepted it. As in Deep Field, the event horizon inside the gate opens only then.',
    live: s => (!s.seq ? ''
      : s.quorumReached ? `Ledger ${fmt(s.seq)}: ${s.count} signed. That is a quorum, so the horizon is open.`
      : `Ledger ${fmt(s.seq)}: ${s.count} signed so far, ${Math.max(0, s.quorum - s.count)} more needed.`) },
  { id: 'ledger', name: 'the ledger', at: [-0.15, 0, -1.3], r: 1.75, yaw: -1.08, pitch: 0.2, mark: () => [0, 0, 0.03],
    title: () => 'The ledger itself',
    body: () => 'What the validators sign is the ledger’s fingerprint, its hash. Your browser computes that hash ' +
      'from the ledger’s header itself and compares the two. When they match, the heart of the horizon lights, and ' +
      'the ledger joins the rings behind the gate: one for each ledger proven here since you arrived.',
    live: s => (s.header ? `Ledger ${fmt(s.seq)}: its header hashes to ${s.header.slice(0, 10)}…, exactly what they signed.`
      : s.seq ? `Ledger ${fmt(s.seq)}: its header is checked once the quorum is in…` : '') },
  { id: 'account', name: 'an account', at: [1.2, -0.45, -0.2], r: 1.4, yaw: -0.36, pitch: 0.1, mark: () => BODY_AT, form: true,
    title: () => 'Any account, down to the drop',
    body: () => 'Look up an address. It appears beyond the gate as an outline: the relay’s word. Then your browser ' +
      'follows that account’s path through the ledger’s state tree, one step for each hex digit of its key, hashing ' +
      'every node up to the state root in the heart. Only if it all checks out does the path light, and the body with it.',
    live: s => {
      const a = s.acct;
      if (!a) return 'Try the genesis account: the first account the ledger ever had.';
      // the latest ledger it was proven in holds until the next one is: no flicker
      // back to an outline while each new ledger is still being checked
      const p = a.proven;
      if (p) return p.absent ? `Proven: ledger ${fmt(p.seq)} has no such account.`
                             : `Lit: ${p.xrp} XRP, proven against ledger ${fmt(p.seq)}.`;
      if (a.state === 'failed') return `Still an outline: ${a.why}.`;
      return a.told ? `An outline for now: ${a.told} XRP, the relay says. Watch it light.`
                    : 'An outline for now: the relay found no such account. Checking…';
    } },
  { id: 'closer', name: 'looking closer', names: true, at: [0.1, 0.05, -0.2], r: 1.55, yaw: -0.42, pitch: 0.1, mark: n => out(lightAt(Math.round(n * 0.64), n), 1.62),
    title: () => 'Look closer',
    body: s => 'Names shows whose light is whose. ' +
      `${s.touch ? 'Drag to turn the view and pinch to come closer; double-tap to come back' : 'Drag to turn the view and scroll to come closer'}. ` +
      'And paste a transaction hash into the lookup box: your browser proves it and makes a receipt, a PDF that ' +
      'carries its own proof.',
    live: s => `Tour, in the menu ${s.stacked ? 'at the bottom' : 'at the top right'}, brings this back any time.` },
];

export class Tour {
  /** `api` is the page: its state, its camera, its lights and its lookup. */
  constructor(api) {
    this.api = api; this.i = -1; this.on = false; this.e = {};
    const $ = id => document.getElementById(id);
    this.el = $('tour'); this.num = $('tour-num'); this.title = $('tour-title'); this.body = $('tour-body');
    this.liveEl = $('tour-live'); this.say = $('tour-say'); this.form = $('tour-form');
    this.next = $('tour-next'); this.back = $('tour-back'); this.skip = $('tour-skip');
    this.dim = $('tour-dim');
    // the narrator: this stop's voice, and the next one's, fetched while this one plays
    this.voice = new Audio(); this.voice.preload = 'auto';
    this.ahead = new Audio(); this.ahead.preload = 'auto';
    this.voiceBtn = $('tour-voice'); this.blocked = false;
    try { this.narrate = localStorage.getItem(VOICE) !== '0'; } catch (e) { this.narrate = true; }
    try { this.who = VOICES.includes(localStorage.getItem(WHO)) ? localStorage.getItem(WHO) : VOICES[0]; } catch (e) { this.who = VOICES[0]; }
    $('tour-who').addEventListener('click', () => {
      // the other narrator takes over this stop, from the top
      this.who = VOICES[(VOICES.indexOf(this.who) + 1) % VOICES.length];
      this.narrate = true;
      try { localStorage.setItem(WHO, this.who); localStorage.setItem(VOICE, '1'); } catch (e) { /* storage blocked */ }
      this.speak();
    });
    this.voiceBtn.addEventListener('click', () => {
      // a narrator the browser held back: this click is the permission it waited for
      this.narrate = !(this.narrate && !this.blocked);
      try { localStorage.setItem(VOICE, this.narrate ? '1' : '0'); } catch (e) { /* storage blocked */ }
      if (this.narrate) this.speak(); else this.hush();
    });
    for (const ev of ['playing', 'pause', 'ended']) this.voice.addEventListener(ev, () => this.voiceState());
    this.voice.addEventListener('ended', () => this.api.duck(false));
    const pips = $('tour-pips'), marks = $('tour-marks');
    this.pips = []; this.marks = [];
    STEPS.forEach((s, i) => {
      if (!i) return;
      const li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button'; b.textContent = i; b.setAttribute('aria-label', `Stop ${i}: ${s.name}`);
      b.addEventListener('click', () => this.go(i));
      li.append(b); pips.append(li); this.pips[i] = b;
      const m = document.createElement('button');
      m.type = 'button'; m.className = 't-mark'; m.textContent = i; m.tabIndex = -1; m.title = `Stop ${i}: ${s.name}`;
      m.setAttribute('aria-hidden', 'true');
      m.addEventListener('click', () => this.go(i));
      marks.append(m); this.marks[i] = m;
    });
    this.next.addEventListener('click', () => (this.i < STEPS.length - 1 ? this.go(this.i + 1) : this.end()));
    this.back.addEventListener('click', () => this.go(Math.max(0, this.i - 1)));
    this.skip.addEventListener('click', () => this.end());
    this.form.addEventListener('submit', e => {
      e.preventDefault();
      const v = $('tour-addr').value.trim();
      if (v) api.lookup(v);
    });
    $('tour-genesis').addEventListener('click', () => { $('tour-addr').value = GENESIS; api.lookup(GENESIS); });
    addEventListener('keydown', e => {
      if (!this.on || (e.target instanceof Element && e.target.closest('input, textarea'))) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); this.next.click(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); if (this.i > 0) this.go(this.i - 1); }
      else if (e.key === 'Escape') this.end();
    });
    addEventListener('resize', () => {
      if (!this.on) return;
      clearTimeout(this.rt);
      this.rt = setTimeout(() => this.aim(), 150);
    });
  }

  static seen() {
    try { return !!localStorage.getItem(SEEN); } catch (e) { return false; }
  }

  start(i = 0) {
    // remembered as soon as it opens: nobody is walked through it twice
    try { localStorage.setItem(SEEN, '1'); localStorage.setItem('proof.hinted', '1'); } catch (e) { /* storage blocked */ }
    this.on = true; this.e = {};
    this.api.prepare();
    this.el.hidden = false;
    document.body.classList.add('touring');
    this.go(i);
  }

  go(i) {
    if (!this.on) return;
    const was = STEPS[this.i], s = STEPS[i];
    // a stop that showed the names puts them back as they were, unless the visitor changed them
    if (was && was.names && this.api.names() && !this.namesBefore) this.api.names(false);
    if (s.names) { this.namesBefore = this.api.names(); this.api.names(true); }
    this.i = i;
    const st = this.api.state();
    this.el.classList.toggle('intro', i === 0);
    document.body.dataset.tour = s.id;
    this.num.textContent = i ? String(i) : '';
    this.title.textContent = s.title(st);
    this.body.textContent = s.body(st);
    this.form.hidden = !s.form;
    this.back.hidden = i === 0;
    this.next.textContent = i === 0 ? 'Walk me through it' : i === STEPS.length - 1 ? 'Done' : `Next: ${STEPS[i + 1].name}`;
    this.skip.textContent = i === 0 ? 'Skip the tour' : 'End the tour';
    this.pips.forEach((b, k) => b && (k === i ? b.setAttribute('aria-current', 'step') : b.removeAttribute('aria-current')));
    this.marks.forEach((m, k) => m && m.classList.toggle('on', i === 0 || k === i));
    this.say.textContent = i ? `Stop ${i} of ${STEPS.length - 1}: ${this.title.textContent}` : this.title.textContent;
    this.live();
    this.aim();
    this.speak();
    this.next.focus({ preventScroll: true });
  }

  /** Read this stop aloud, if the narrator is on. Browsers refuse sound until
   *  the visitor has clicked something: then the button offers to play it. */
  speak() {
    const s = STEPS[this.i];
    if (!this.on || !this.narrate || !s) { this.voiceState(); return; }
    const src = `audio/${this.who}/tour-${s.id}.mp3`;
    if (!this.voice.src.endsWith(src)) this.voice.src = src;
    this.voice.currentTime = 0;
    this.blocked = false;
    this.api.duck(true);
    this.voice.play().catch(() => { this.blocked = true; this.api.duck(false); this.voiceState(); });
    const n = STEPS[this.i + 1];
    if (n) this.ahead.src = `audio/${this.who}/tour-${n.id}.mp3`;
    this.voiceState();
  }

  hush() { this.voice.pause(); this.api.duck(false); this.voiceState(); }

  voiceState() {
    this.voiceBtn.setAttribute('aria-pressed', String(this.narrate && !this.blocked));
    this.voiceBtn.textContent = this.narrate && this.blocked ? 'Play narration' : 'Narration';
    this.voiceBtn.toggleAttribute('data-speaking', !this.voice.paused && !this.voice.ended);
  }

  end() {
    if (!this.on) return;
    const s = STEPS[this.i];
    if (s && s.names && !this.namesBefore) this.api.names(false);
    this.on = false; this.i = -1;
    this.hush();
    this.el.hidden = true;
    document.body.classList.remove('touring');
    delete document.body.dataset.tour;
    this.marks.forEach(m => m && m.classList.remove('on'));
    this.dim.classList.remove('on');
    this.api.fit();
  }

  /** Something happened on the press: the live line follows it. */
  event(type, d = {}) {
    if (type === 'begin') this.e.signed = null;
    else if (type === 'signed') this.e.signed = this.api.name(d.idx);
    if (this.on) this.live();
  }

  live() {
    const s = STEPS[this.i];
    const t = s && s.live ? s.live(this.api.state(), this.e) : '';
    if (this.liveEl.textContent !== t) this.liveEl.textContent = t;
  }

  /** The room left for the sky: above the caption band, or beside it when
   *  a phone on its side puts the band down the right. */
  box() {
    const W = innerWidth, H = innerHeight, r = this.el.getBoundingClientRect();
    document.documentElement.style.setProperty('--band-h', `${Math.round(H - r.top)}px`);   // the log stops above the band
    if (r.top < 40 && r.left > W * 0.3) return [10, 46, r.left - 12, H - 10];
    const top = document.documentElement.classList.contains('stacked') ? 56 : 88;
    return [20, top, W - 20, Math.max(top + 120, r.top - 14)];
  }

  aim() {
    const s = STEPS[this.i];
    if (!s) return;
    if (s.at) this.api.frame(s, this.box());
    else this.api.fit(this.box());
  }

  /** Every frame: the numbers ride in the sky, and the light pools on this stop. */
  frame() {
    if (!this.on) return;
    const n = this.api.n();
    STEPS.forEach((s, i) => {
      const m = this.marks[i];
      if (!m || !m.classList.contains('on')) return;
      const [x, y, z] = this.api.screen(s.mark(n));
      m.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      m.style.visibility = z > 1 ? 'hidden' : '';
    });
    const s = STEPS[this.i];
    if (!s.at) { this.dim.classList.remove('on'); return; }
    const [x, y] = this.api.screen(s.at), rad = this.api.size(s.at, s.r);
    const d = this.dim.style;
    d.setProperty('--cx', `${x.toFixed(1)}px`);
    d.setProperty('--cy', `${y.toFixed(1)}px`);
    d.setProperty('--rx', `${(rad * 1.9).toFixed(1)}px`);
    d.setProperty('--ry', `${(rad * 1.7).toFixed(1)}px`);
    this.dim.classList.add('on');
  }
}
