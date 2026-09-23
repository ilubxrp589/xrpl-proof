/* The tour: the proof explained the way a banknote's security features are,
 * one numbered mark at a time. The camera flies to each mark while the page
 * keeps printing, so every step points at something happening now, checked
 * in this browser, rather than at a picture of it. A narrator reads each stop
 * (audio/<voice>/tour-<id>.mp3: Kokoro-82M, rendered ahead of time; the scripts are
 * written for the ear, so they say less than the band and name no numbers
 * that could change).
 *
 * It opens by itself on a first visit; "How to read it" brings it back. */

const SEEN = 'proof.toured';
const VOICE = 'proof.narrate';        // '0' once the visitor turns the narrator off
const WHO = 'proof.voice';            // which narrator: audio/<name>/tour-<stop>.mp3
const VOICES = ['heart', 'fenrir'];   // Kokoro af_heart and am_fenrir: the tour's two narrators
const GENESIS = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';   // the first account the ledger ever had
const fmt = n => Number(n).toLocaleString('en-US');

// Each stop frames `rect` of the sheet and sets its number at `mark` (both in
// sheet pixels, 3600 × 2400); `mode` is the light to hold the sheet under.
const STEPS = [
  { id: 'intro',
    title: () => 'A ledger, checked in your browser',
    body: () => 'Every few seconds the XRP Ledger’s validators agree on a new ledger and sign it. ' +
      'This page doesn’t take anyone’s word for it. It checks every signature itself, then prints a proof of ' +
      'what passed: ink means checked here, pencil means someone else said so. ' +
      'The numbers mark the seven things to look at.',
    live: s => (s.seq ? `Ledger ${fmt(s.seq)} is on the press now.` : 'Waiting for the next ledger to close…') },
  { id: 'key', name: 'the key', mode: 2, rect: [2640, 560, 740, 1000], mark: [2790, 660],
    title: () => 'One key, held to the light',
    body: s => 'Everything here is checked against a single key, and that key is in the paper rather than ' +
      `printed on it: you only see it with the light behind the sheet. It belongs to ${s.root}, which ` +
      `publishes the list of validators. After the tour, you can trust ${s.other}’s key instead, ` +
      `${s.stacked ? 'below the sheet' : 'at the bottom right'}.`,
    live: s => `The key: ${s.rootKey.slice(0, 12)}…${s.rootKey.slice(-8)}` },
  { id: 'list', name: 'the list', rect: [1240, 1230, 1120, 500], mark: [1320, 1600],
    title: () => 'The list it signed',
    body: s => `That key signed a list of ${s.total} validators, and your browser checks that signature before ` +
      'anything else. Each validator on the list then vouches for the key it signs with today. ' +
      'Once all of that holds, the steps of the temple are inked.',
    live: s => `Checked in this browser: the list’s signature, and the keys of all ${s.total} validators.` },
  { id: 'sigs', name: 'the signatures', rect: [980, 1190, 1640, 890], mark: [2615, 1750],
    title: s => `${s.total} columns, ${s.total} validators`,
    body: () => 'Each validator on the list signs every ledger. When your browser has checked one validator’s ' +
      'signature on the ledger being printed, that validator’s column fills with ink, and its autograph appears ' +
      'below, drawn from the bytes of that signature.',
    live: (s, e) => (!s.seq ? 'Waiting for the next ledger…'
      : s.count >= s.total ? `Ledger ${fmt(s.seq)}: all ${s.total} checked.`
      : `Ledger ${fmt(s.seq)}: ${s.count} of ${s.total} checked so far${e.signed ? `, the latest from ${e.signed}` : ''}.`) },
  { id: 'quorum', name: 'the quorum', rect: [290, 670, 660, 840], mark: [370, 760],
    title: s => `${s.quorum} of ${s.total} must agree`,
    body: s => `The rosette counts the signatures checked so far. Once ${s.quorum} of the ${s.total} have signed ` +
      'the same ledger, that is a quorum: the network has accepted the ledger. The roof goes on the temple, and ' +
      'the star on the foil seal at the right is struck.',
    live: s => (!s.seq ? ''
      : s.quorumReached ? `Ledger ${fmt(s.seq)}: ${s.count} signed. That is a quorum, so the roof is on.`
      : `Ledger ${fmt(s.seq)}: ${s.count} signed so far, ${Math.max(0, s.quorum - s.count)} more needed.`) },
  { id: 'ledger', name: 'the ledger', rect: [1320, 630, 960, 680], mark: [1430, 830],
    title: () => 'The ledger itself',
    body: () => 'What the validators sign is the ledger’s fingerprint, its hash. Your browser computes that hash ' +
      'from the ledger’s header itself and compares the two. When they match, rays spread from the dome, and the ' +
      'ledger’s details are printed at the bottom left: its hash, its state root, when it closed, and how much XRP exists.',
    live: s => (s.header ? `Ledger ${fmt(s.seq)}: its header hashes to ${s.header.slice(0, 10)}…, exactly what they signed.`
      : s.seq ? `Ledger ${fmt(s.seq)}: its header is checked once the quorum is in…` : '') },
  { id: 'account', name: 'an account', rect: [230, 1700, 880, 410], mark: [966, 1990], form: true,
    title: () => 'Any account, down to the drop',
    body: () => 'Look up an address. The relay’s answer is written in pencil first. Then your browser follows ' +
      'that account’s path through the ledger’s state tree, hashing every step up to the state root, and inks the ' +
      'balance only if it all checks out. The lantern on top of the dome lights up.',
    live: s => {
      const a = s.acct;
      if (!a) return 'Try the genesis account: the first account the ledger ever had.';
      // the latest ledger it was proven in holds until the next one is: no flicker
      // back to pencil while each new ledger is still being checked
      const p = a.proven;
      if (p) return p.absent ? `Proven: ledger ${fmt(p.seq)} has no such account.`
                             : `In ink: ${p.xrp} XRP, proven against ledger ${fmt(p.seq)}.`;
      if (a.state === 'failed') return `Still in pencil: ${a.why}.`;
      return a.told ? `In pencil for now: ${a.told} XRP, the relay says. Watch it turn to ink.`
                    : 'In pencil for now: the relay found no such account. Checking…';
    } },
  { id: 'closer', name: 'looking closer', mode: 3, rect: [980, 560, 1640, 1150], mark: [2600, 1000],
    title: () => 'Look closer',
    body: s => 'Under ultraviolet, the names of this ledger’s signers glow around the temple. ' +
      `${s.touch ? 'Pinch to zoom in anywhere (double-tap to come back)' : 'Scroll to zoom in anywhere'}, or take ` +
      'out the loupe to read the microprint in the border: it spells out the trusted key. Turn the sheet over ' +
      'for the checklist of every step, ticked for this ledger.',
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
    // a stop that changed the light puts it back, unless the visitor chose another
    if (was && was.mode !== undefined && this.api.mode() === was.mode) this.api.mode(this.modeBefore || 0);
    if (s.mode !== undefined) { this.modeBefore = this.api.mode(); this.api.mode(s.mode); }
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
    if (s && s.mode !== undefined && this.api.mode() === s.mode) this.api.mode(this.modeBefore || 0);
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

  /** The room left for the sheet: above the caption band, or beside it when
   *  a phone on its side puts the band down the right. */
  box() {
    const W = innerWidth, H = innerHeight, r = this.el.getBoundingClientRect();
    if (r.top < 40 && r.left > W * 0.3) return [10, 46, r.left - 12, H - 10];
    const top = document.documentElement.classList.contains('stacked') ? 60 : 92;
    return [20, top, W - 20, Math.max(top + 120, r.top - 14)];
  }

  aim() {
    const s = STEPS[this.i];
    if (!s) return;
    if (s.rect) this.api.frame(s.rect, this.box());
    else this.api.fit(this.box());
  }

  /** Every frame: the numbers ride on the sheet, and the light pools on this stop. */
  frame() {
    if (!this.on) return;
    const hidden = this.api.flipped();
    STEPS.forEach((s, i) => {
      const m = this.marks[i];
      if (!m || !m.classList.contains('on')) return;
      const [x, y] = this.api.screen(s.mark[0], s.mark[1]);
      m.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      m.style.visibility = hidden ? 'hidden' : '';
    });
    const s = STEPS[this.i];
    if (!s.rect || hidden) { this.dim.classList.remove('on'); return; }
    const [x, y, w, h] = s.rect;
    const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([a, b]) => this.api.screen(a, b));
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const d = this.dim.style;
    d.setProperty('--cx', `${((x0 + x1) / 2).toFixed(1)}px`);
    d.setProperty('--cy', `${((y0 + y1) / 2).toFixed(1)}px`);
    d.setProperty('--rx', `${((x1 - x0) * 0.95).toFixed(1)}px`);
    d.setProperty('--ry', `${((y1 - y0) * 0.95).toFixed(1)}px`);
    this.dim.classList.add('on');
  }
}
