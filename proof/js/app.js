/* Proof: the page. It fetches raw bytes from an untrusted relay, has the
 * worker check them, and lights the sky only with what came back verified.
 *
 * The display runs one ledger behind the network: a ledger's validations
 * keep arriving after it closes, so ledger N is shown once N+1 has closed,
 * and each signature lights in the order, and at the pace, it actually
 * arrived. Anything that arrives later still lights, live. */
import { Sky, HOME, HOME_TALL, KEY_AT, BODY_AT, lightAt } from './scene.js';
import { TRUST_ROOTS, accountKey } from './verify.js';
import { Sound } from './audio.js';
import { Tour } from './tour.js';
import { buildReceipt } from './receipt.js';
import { receiptPdf, readEvidence } from './pdf.js';
import { drawReceipt, amountText, headline, utc, RW, RH } from './receipt-art.js';
import { drawSpaceReceipt, spaceFonts } from './receipt-space.js';
import { xrpText } from './engrave.js';

const $ = s => document.querySelector(s);
const RELAY = (() => {
  const q = new URLSearchParams(location.search).get('relay');
  if (q) return q.replace(/\/$/, '');
  if (location.protocol === 'file:' || ['127.0.0.1', 'localhost'].includes(location.hostname)) return 'http://127.0.0.1:3783';
  return location.origin + '/proof-feed';
})();
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;      // fingers, not a mouse
const fmt = n => Number(n).toLocaleString('en-US');
const hs = x => Number(x).toLocaleString('en-US').replace(/,/g, ' ');
const xrp = d => xrpText(d, ' ');                    // grouped with narrow spaces
const short = h => `${h.slice(0, 12)}…`;
const RIPPLE_EPOCH = 946684800;

let sky = null, sound = new Sound(), tour = null;
let list = null, listRaw = null, rootName = new URLSearchParams(location.search).get('root') === 'xrplf' ? 'xrplf' : 'ripple';
const ledgers = new Map();        // seq → buffered, checked material
let show = null, hold = false, proven = 0, ws = null, names = false;
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

function ledger(seq) {
  let L = ledgers.get(seq);
  if (!L) {
    L = { seq, hash: null, header: null, closeAt: 0, hdr: null, checks: [], byHash: new Map(), proven: false };
    ledgers.set(seq, L);
    for (const k of ledgers.keys()) if (k < seq - 12) ledgers.delete(k);
  }
  return L;
}

// ── the worker's answers ────────────────────────────────────────────────────
worker.onmessage = e => {
  const m = e.data;
  if (m.t === 'list') {
    if (!m.ok) return fail(`The validator list could not be checked: ${m.error}.`, m.steps);
    list = m;
    start();
  } else if (m.t === 'val') {
    const r = m.res;
    // not on the list, a bad signature, or a partial validation (rippled does not
    // count those toward a quorum): never lit
    if (r.idx < 0 || !r.ok || !r.full) return;
    const L = ledger(r.seq);
    if (L.checks.some(c => c.idx === r.idx && c.hash === r.hash)) return;
    const c = { idx: r.idx, hash: r.hash, sig: r.sig, at: m.at, data: m.data };   // the raw bytes go into receipts
    L.checks.push(c);
    L.byHash.set(r.hash, (L.byHash.get(r.hash) || 0) + 1);
    settle(L);
    if (show && show.seq === r.seq) show.queue.push({ ...c, t: show.elapsed });
  } else if (m.t === 'header') {
    const L = ledger(m.seq);
    L.hdr = m.res;
    settle(L);
    askProof(L);
  } else if (m.t === 'receipt') {
    const done = receiptWait.get(m.id);
    if (done) { receiptWait.delete(m.id); done(m.res); }
  } else if (m.t === 'proof') {
    const L = ledgers.get(m.seq);
    if (!L || !watch || m.addr !== watch.addr) return;
    L.acct = m.res;
    if (show && show.seq === L.seq && show.acctDone) paintAccount(L);   // arrived late: show it now
  }
};

/** A ledger is proven once a quorum of the list signed one hash and its
 *  header hashes to exactly that. Counted whether or not it is on screen. */
function settle(L) {
  if (L.proven || !L.hdr || !list) return;
  const n = L.checks.filter(c => c.hash === L.hdr.hash).length;
  if (n >= list.quorum) {
    L.proven = true;
    proven++;
    // a link with ?tx= proves that transaction as soon as there is a ledger to anchor it
    if (wantTx) { const t = wantTx; wantTx = null; setTimeout(() => proveTx(t), 400); }
    $('#tally').textContent = `${fmt(proven)} ledger${proven === 1 ? '' : 's'} proven in this browser since you arrived.`;
  }
}

// ── the relay ───────────────────────────────────────────────────────────────
async function boot() {
  try { await spaceFonts(); } catch (e) { /* the system faces will do */ }
  try {
    sky = new Sky($('#sky'));
  } catch (e) {
    return fail(String(e.message || e));
  }
  layout(true);
  requestAnimationFrame(tick);
  loadList();
}

async function loadList() {
  setWhen(`Checking the validator list against ${TRUST_ROOTS[rootName].name}…`);
  row('list', 'pending', '', 'checking its signature…');
  try {
    const [vl, mf] = await Promise.all([
      fetch(`${RELAY}/vl?src=${rootName}`).then(r => r.json()),
      fetch(`${RELAY}/manifests`).then(r => r.json()),
    ]);
    worker.postMessage({ t: 'list', body: vl, manifests: mf.manifests, root: rootName });
    listRaw = { root: rootName, body: vl, manifests: mf.manifests };   // as fetched, for receipts
  } catch (e) {
    fail('The relay is not answering, so there is nothing to check yet. It will be retried in ten seconds.');
    setTimeout(loadList, 10000);
  }
}

function start() {
  const root = TRUST_ROOTS[list.root];
  sky.setList(list.validators);
  nameTags();
  // the legend's numbers come from the list this page verified, not from a guess
  document.querySelectorAll('[data-n]').forEach(e => { e.textContent = list.validators.length; });
  document.querySelectorAll('[data-q]').forEach(e => { e.textContent = list.quorum; });
  $('#root-name').textContent = root.name;
  $('#root-key').textContent = `${root.key.slice(0, 10)}…${root.key.slice(-8)}, built in`;
  $('#root-key').title = root.key;
  const until = list.expiration ? new Date((list.expiration + RIPPLE_EPOCH) * 1000).toISOString().slice(0, 10) : null;
  row('list', 'lit', `${list.validators.length} validators`,
      `list ${list.sequence}, signed by that key${until ? `, good until ${until}` : ''}; each vouches for today’s signing key`);
  document.body.classList.add('live');
  document.body.classList.remove('failed');
  setWhen('The list checks out. Waiting for the next ledger…');
  connect();
  if (!tour) {
    tour = new Tour(tourApi);
    // it opens by itself on a first visit; ?tour forces it, ?notour (for links and tests) skips it
    const q = new URLSearchParams(location.search);
    if ((!Tour.seen() && !q.has('notour')) || q.has('tour')) tour.start();
  }
}

function connect() {
  if (ws) { ws.onclose = null; ws.close(); }
  ws = new WebSocket(RELAY.replace(/^http/, 'ws'));
  ws.onmessage = e => {
    const f = JSON.parse(e.data);
    if (f.t === 'hello') {
      skew = f.at - Date.now();
      lastClose = f.tip_at ? performance.now() - Math.max(0, f.at - f.tip_at) : performance.now();
    }
    if (f.t === 'ledger') {
      const L = ledger(f.seq);
      L.hash = f.hash; L.header = f.header; L.closeAt = f.at;
      if (f.header) worker.postMessage({ t: 'header', seq: f.seq, header: f.header, hash: f.hash });
      newest = Math.max(newest, f.seq);
      // when did the relay see this ledger close, on this page's clock
      lastClose = Math.max(lastClose, performance.now() - Math.max(0, Date.now() + skew - f.at));
      // a new close means the one before it has its signatures in: show it next
      if (!f.replay) wantShow = true;
    } else if (f.t === 'val') {
      worker.postMessage({ t: 'val', data: f.data, at: f.at, replay: !!f.replay });
    }
  };
  ws.onopen = () => { wantShow = true; };
  ws.onclose = () => { setWhen('The relay closed the connection. Reconnecting…'); setTimeout(connect, 3000); };
}
let newest = 0, wantShow = false, lastClose = 0, skew = 0;

// ── showing one ledger ──────────────────────────────────────────────────────
/** The ledger to show next: the newest one older than the latest close that
 *  already has checked signatures. The checks can trail the closes by a few
 *  seconds on a slow machine, so this is chosen when it is time, not when
 *  the close arrives. */
function pickNext() {
  let best = null;
  for (const [seq, L] of ledgers)
    if (seq < newest && L.checks.length && (!show || seq > show.seq) && (!best || seq > best)) best = seq;
  return best;
}

function begin(seq) {
  const L = ledgers.get(seq);
  if (!L) return;
  // the last ledger's lights drain slowly while this one's checks fill them again: nothing blinks
  sky.begin();
  // replay each check at the offset it actually arrived after the close
  const span = reduced ? 0.001 : 2.8;
  const offs = L.checks.map(c => Math.max(0, (c.at - L.closeAt) / 1000));
  const maxOff = Math.max(0.5, ...offs);
  const scale = Math.min(1, span / maxOff);
  show = { seq, elapsed: 0, queue: L.checks.map((c, i) => ({ ...c, t: 0.15 + offs[i] * scale })),
           signed: new Set(), count: 0, quorumAt: null, quorumHash: null, headerAt: null,
           mismatch: false, acctDone: false, latest: null };
  $('#lg-seq').textContent = hs(seq);
  row('header', 'pending', '', 'checked once a quorum has signed');
  recount();
  if (watch) askProof(L);                 // a proven balance stays lit until this ledger's own proof arrives
  if (tour) tour.event('begin', { seq });
  if (!hintShown) { hintShown = true; setTimeout(showHint, 2500); }
}
let hintShown = false;

function step(dt) {
  if (wantShow && !hold) {
    const next = pickNext();
    if (next !== null) { wantShow = false; begin(next); }
  }
  if (!show) return;
  show.elapsed += dt;
  const L = ledgers.get(show.seq);
  if (!L) return;
  const hash = targetHash(L);
  if (hash !== show.hash) { show.hash = hash; recount(); }   // the header arrived: count against it
  let maj = null, majN = 0;
  for (const [h, k] of L.byHash) if (k > majN) { maj = h; majN = k; }
  show.mismatch = !!(L.hdr && maj && maj !== L.hdr.hash && majN >= list.quorum);
  for (const ev of show.queue) {
    if (ev.fired || ev.t > show.elapsed) continue;
    ev.fired = true;                     // it has arrived; it counts only if it signed `hash`
    if (ev.hash !== hash || show.signed.has(ev.idx)) continue;
    sky.signed(ev.idx, ev.sig);          // the signature's own bytes, straight from the worker
    sound.pluck(ev.idx);
    show.latest = ev.idx;
    recount();
    if (tour) tour.event('signed', { idx: ev.idx });
  }
  // the heart: the header must hash to exactly what the quorum signed
  if (show.quorumAt !== null && show.headerAt === null && L.hdr && L.hdr.hash === show.quorumHash) {
    show.headerAt = show.elapsed;
    sky.header();
    const h = L.hdr;
    row('header', 'lit', short(h.hash), `what the quorum signed; state root ${h.stateRoot.slice(0, 10)}…; ${xrp(h.drops)} XRP exist`);
    setWhen(`closed ${new Date((h.close + RIPPLE_EPOCH) * 1000).toISOString().slice(11, 19)} UTC`);
    sound.bell();
    if (tour) tour.event('header');
  }
  // the account: its entry hashes up to this header's state root
  if (watch && show.headerAt !== null && !show.acctDone && show.elapsed >= show.headerAt + 0.6) {
    show.acctDone = true;
    if (L.acct) paintAccount(L);
  }
  status();
}

/** The hash signatures are counted against: the header's, once this page has
 *  hashed it; until then, whichever hash most checked signatures agree on. */
function targetHash(L) {
  if (L.hdr) return L.hdr.hash;
  let best = null, n = 0;
  for (const [h, k] of L.byHash) if (k > n) { best = h; n = k; }
  return best;
}

/** Recount from what has arrived: the signatures on the current hash. The lights follow the same set. */
function recount() {
  if (!show) return;
  show.signed = new Set(show.queue.filter(ev => ev.fired && ev.hash === show.hash).map(ev => ev.idx));
  sky.signers(show.signed);
  const n = show.signed.size;
  show.count = n;
  const total = list.validators.length;
  row('sigs', n ? 'lit' : 'pending', `${n} of ${total} checked`, show.latest !== null && show.signed.has(show.latest) ? `latest: ${nameOf(show.latest)}` : '');
  const standing = show.quorumAt !== null;
  if (n >= list.quorum && (!standing || show.quorumHash !== show.hash)) {
    show.quorumAt = show.elapsed; show.quorumHash = show.hash;
    show.headerAt = null; show.mismatch = false;
    sky.quorum(true);
    sound.quorum();
    if (tour) tour.event('quorum');
  } else if (n < list.quorum && standing) {
    // the header came in, and it is not the ledger they signed: the horizon closes
    show.quorumAt = null; show.quorumHash = null; show.headerAt = null; show.mismatch = false;
    sky.quorum(false);
    row('header', 'refused', 'not what they signed', 'the relay sent a header that does not hash to what the quorum signed');
    if (show.acctDone) {
      // the state root is no longer vouched for, so neither is the balance
      show.acctDone = false;
      if (watch) { told(); note(); }
    }
    sound.thud();
  }
  const q = list.quorum;
  row('quorum', show.quorumAt !== null ? 'lit' : 'pending', `${q} of ${total} needed`,
      show.quorumAt !== null ? 'reached: the horizon is open' : `${Math.max(0, q - n)} more to go`);
}

// ── the words on the left ───────────────────────────────────────────────────
function row(id, state, v, d) {
  const li = $(`#ck-${id}`);
  li.dataset.state = state;
  li.querySelector('.v').textContent = v;
  li.querySelector('.d').textContent = d;
}
function setWhen(s) { $('#lg-when').textContent = s; }
let lastStatus = '';
function status() {
  // say so when the relay's node goes quiet, rather than showing an old proof as if it were current
  const quiet = lastClose ? (performance.now() - lastClose) / 1000 : 0;
  let s;
  if (quiet > 20) {
    const age = quiet < 120 ? `${Math.round(quiet)} seconds` : `${Math.round(quiet / 60)} minutes`;
    s = `The relay's newest ledger is ${age} old; its node may have fallen behind.` + (show ? ` Ledger ${fmt(show.seq)} stays in view until a new one arrives.` : '');
    setWhen(s);
  } else if (!show) return;
  else {
    s = `Ledger ${fmt(show.seq)}. ${show.count} of ${list.validators.length} signatures checked in this browser`;
    if (show.mismatch) s += '. The relay sent a header that does not hash to what the quorum signed, so this ledger is not proven.';
    else if (show.quorumAt !== null && show.headerAt !== null) s += '; quorum reached, and the header hashes to what they signed.';
    else if (show.quorumAt !== null) s += '; quorum reached.';
    else s += '.';
  }
  if (s !== lastStatus) { lastStatus = s; $('#status').textContent = s; }
}
setInterval(() => { if (list) status(); }, 2000);
function fail(msg, steps) {
  setWhen(msg);
  document.body.classList.add('failed');
  if (/list/.test(msg)) row('list', 'refused', 'not checked', msg);
  if (steps) console.warn(steps);
}
const nameOf = i => (list && list.validators[i] ? list.validators[i].domain || list.validators[i].master.slice(0, 10) + '…' : '');

// ── the view ────────────────────────────────────────────────────────────────
// Drag turns it about the gate, the wheel or a pinch comes closer; the tour flies it.
const view = { ...HOME, dist: 6, target: HOME.centre.slice(), lens: [0, 0], glide: false, moved: false };
let home = null;
/** The part of the screen the sky has to itself. */
function skyBox() {
  const W = innerWidth, H = innerHeight, stacked = document.documentElement.classList.contains('stacked');
  if (stacked) {
    const bottom = Math.round(H * 0.56);
    document.documentElement.style.setProperty('--sky-bottom', `${bottom}px`);
    return [8, 56, W - 8, bottom - 6];
  }
  const shortScreen = H <= 520 && W > H;
  const log = $('#log').getBoundingClientRect();
  const left = log.right + (shortScreen ? 6 : 24), top = shortScreen ? 44 : 86;
  return [left, top, W - 20, H - (shortScreen ? 8 : 24)];
}
function layout(snap = false) {
  document.documentElement.classList.toggle('stacked', innerWidth / innerHeight < 1);
  measureNav();
  const h = homeView();
  home = sky.frameSphere(h.centre, h.radius, skyBox(), h.yaw, h.pitch);
  if (snap || (!view.moved && !(tour && tour.on))) { Object.assign(view, home, { target: home.target.slice(), lens: home.lens.slice() }); if (snap) Object.assign(sky.view, structuredClone(home)); }
}
const homeView = () => (document.documentElement.classList.contains('stacked') ? HOME_TALL : HOME);
function goHome(glide = true) { Object.assign(view, home, { target: home.target.slice(), lens: home.lens.slice(), glide, moved: false }); $('#fit').hidden = true; }
function moved() { view.moved = true; view.glide = false; $('#fit').hidden = false; hideHint(); }
function orbit(dx, dy) {
  view.yaw = Math.max(home.yaw - 1.25, Math.min(home.yaw + 1.25, view.yaw - dx * 0.0055));
  view.pitch = Math.max(-0.45, Math.min(0.85, view.pitch + dy * 0.0045));
  moved();
}
function dolly(k) { view.dist = Math.max(home.dist * 0.28, Math.min(home.dist * 1.9, view.dist * k)); moved(); }
function measureNav() {
  const nav = $('nav.ui');
  if (nav) document.documentElement.style.setProperty('--nav-h', `${Math.ceil(nav.getBoundingClientRect().height)}px`);
}
addEventListener('resize', () => layout());

// ── the frame ───────────────────────────────────────────────────────────────
let last = performance.now(), clock = 0;
// a slow renderer (software GL in a test harness) may ask for bigger steps
const DT_MAX = Math.min(4, Number(new URLSearchParams(location.search).get('dtmax')) || 0.1);
const perf = window.__proof = { frames: 0, ms: 0, tour: () => tour, sky: () => sky, view: () => view,
  state: () => ({ list: !!list, show: show && show.seq, hold, newest, wantShow,
                  ledgers: [...ledgers].map(([k, L]) => [k, L.checks.length, !!L.hdr, L.proven]),
                  watch: watch && watch.addr, account: sky && sky.acct && sky.acct.state,
                  acct: show && ledgers.get(show.seq) ? ledgers.get(show.seq).acct : null }),
  trace: [], tracing: false };
function tick(now) {
  const dt = Math.min(DT_MAX, (now - last) / 1000);
  perf.frames++; perf.ms = now - last;
  try { frame(dt); } catch (err) {
    // one bad frame must not stop the page: log it once, keep going
    if (!perf.err) console.error(err);
    perf.err = (perf.err || 0) + 1;
  }
  last = now;
  requestAnimationFrame(tick);
}
function frame(dt) {
  clock += dt;
  if (list) step(dt);
  // the eye eases toward where it was sent; at rest it sways a little, so the depth reads
  const k = 1 - Math.exp(-dt * (reduced ? 60 : view.glide ? 2.4 : 11));
  const sway = reduced || view.moved || (tour && tour.on) ? 0 : 0.05 * Math.sin(clock * 0.07);
  const v = sky.view;
  v.yaw += (view.yaw + sway - v.yaw) * k; v.pitch += (view.pitch - v.pitch) * k; v.dist += (view.dist - v.dist) * k;
  for (let i = 0; i < 3; i++) v.target[i] += (view.target[i] - v.target[i]) * k;
  for (let i = 0; i < 2; i++) v.lens[i] += (view.lens[i] - v.lens[i]) * k;
  sky.frame(dt);
  if (perf.tracing) perf.trace.push([+clock.toFixed(2), show && show.seq, +(sky.lit.slice(0, sky.n).reduce((a, b) => a + b, 0) / Math.max(1, sky.n)).toFixed(3), +sky.open.toFixed(3), +sky.heart.toFixed(3)]);
  tags();
  if (tour) tour.frame();
}

// ── words in the sky ────────────────────────────────────────────────────────
let nameEls = [], keyTag = null;
function nameTags() {
  const box = $('#tags');
  nameEls.forEach(e => e.remove());
  nameEls = list.validators.map((_, i) => {
    const e = document.createElement('span');
    e.className = 'tag name'; e.textContent = nameOf(i); e.hidden = true;
    box.append(e);
    return e;
  });
  if (!keyTag) { keyTag = document.createElement('span'); keyTag.className = 'tag key'; box.append(keyTag); }
  keyTag.textContent = `the key: ${TRUST_ROOTS[list.root].name}`;
  keyTag.hidden = true;
}
const place = (el, p, dx = 0, dy = 0, anchor = 0) => {
  if (p[2] > 1) { el.style.visibility = 'hidden'; return; }
  el.style.visibility = '';
  el.style.transform = `translate(${(p[0] + dx).toFixed(1)}px, ${(p[1] + dy).toFixed(1)}px) translate(${anchor * -100}%, -50%)`;
};
function tags() {
  if (!sky || !list) return;
  const on = names && sky.built > 0.99;
  nameEls.forEach((e, i) => {
    e.hidden = !on;
    if (!on) return;
    const p = lightAt(i, sky.n, 0.02), out = [p[0] * 1.45, p[1] * 1.45, p[2]];
    const s = sky.project(out), c = sky.project([0, 0, 0]);
    place(e, s, 0, 0, s[0] < c[0] ? 1 : 0);
    e.classList.toggle('lit', sky.lit[i] > 0.5);
  });
  if (keyTag) { keyTag.hidden = !names; if (names) place(keyTag, sky.project(KEY_AT), 18, 0); }
  const at = $('#acct-tag');
  if (watch) { at.hidden = false; place(at, sky.project(BODY_AT), 26, 0); } else at.hidden = true;
}
function setNames(on) {
  names = on;
  $('#names').setAttribute('aria-pressed', String(on));
}

// ── input ───────────────────────────────────────────────────────────────────
const fingers = new Map();
let drag = null, pinch = null, lastTap = null;
const pair = () => { const [a, b] = [...fingers.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }; };
$('#sky').addEventListener('pointerdown', e => {
  if (e.pointerType === 'touch') {
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fingers.size === 2) { pinch = pair(); if (drag) drag.pinched = true; lastTap = null; return; }
  }
  if (e.button !== 0 || fingers.size > 1) return;
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false };
  try { $('#sky').setPointerCapture(e.pointerId); } catch (err) { /* not a live pointer */ }
});
addEventListener('pointermove', e => {
  if (fingers.has(e.pointerId)) fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && fingers.size >= 2) {
    const m = pair();
    if (pinch.d > 8 && m.d > 8) dolly(pinch.d / m.d);
    pinch = m;
    return;
  }
  if (drag && drag.id === e.pointerId) {
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > (e.pointerType === 'mouse' ? 4 : 10)) { drag.moved = true; document.body.classList.add('dragging'); }
    if (drag.moved && !drag.pinched) orbit(e.clientX - drag.lx, e.clientY - drag.ly);
    drag.lx = e.clientX; drag.ly = e.clientY;
    $('#tip').hidden = true;
    return;
  }
  if (e.pointerType === 'mouse' && e.target === $('#sky')) tip(e.clientX, e.clientY);
});
$('#sky').addEventListener('pointerleave', () => { $('#tip').hidden = true; });
/** Two taps in quick succession: the whole view. Timed by the events' own stamps. */
function tap(x, y, now) {
  if (lastTap && now - lastTap.t < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 36) { lastTap = null; goHome(); hideHint(); return; }
  lastTap = { t: now, x, y };
  tip(x, y, true);
}
const endDrag = e => {
  fingers.delete(e.pointerId);
  if (fingers.size < 2) pinch = null;
  if (!drag || drag.id !== e.pointerId) return;
  const d = drag; drag = null;
  document.body.classList.remove('dragging');
  if (!d.moved && !d.pinched && e.type === 'pointerup' && e.pointerType !== 'mouse') tap(e.clientX, e.clientY, e.timeStamp);
};
$('#sky').addEventListener('pointerup', endDrag);
$('#sky').addEventListener('pointercancel', endDrag);
$('#sky').addEventListener('dblclick', () => { goHome(); hideHint(); });
$('#sky').addEventListener('wheel', e => {
  e.preventDefault();
  dolly(Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0012)));
}, { passive: false });
$('#fit').addEventListener('click', () => goHome());
/** What is under the pointer, in a line: whose light, the key, the account. */
function tip(x, y, touch = false) {
  const t = $('#tip'), hit = sky && list ? sky.pick(x, y) : null;
  if (!hit) { t.hidden = true; return; }
  let html = '';
  if (hit.kind === 'validator') html = `<b>${esc(nameOf(hit.i))}</b><br>${show && show.signed.has(hit.i) ? 'its signature on this ledger is checked' : 'no signature on this ledger checked yet'}`;
  else if (hit.kind === 'key') html = `<b>${esc(TRUST_ROOTS[list.root].name)}</b><br>the one key this page trusts`;
  else if (hit.kind === 'account' && watch) html = `<b>${esc(watch.addr)}</b>`;
  t.innerHTML = html; t.hidden = false;
  const r = t.getBoundingClientRect();
  t.style.transform = `translate(${Math.min(innerWidth - r.width - 8, x + 14)}px, ${Math.max(8, y - r.height - 12)}px)`;
  if (touch) { clearTimeout(tip.t); tip.t = setTimeout(() => { t.hidden = true; }, 2600); }
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let hintTimer = null;
function showHint() {
  if (tour && tour.on) return;
  let seen = false;
  try { seen = !!localStorage.getItem('proof.hinted'); } catch (e) { /* storage blocked */ }
  if (seen) return;
  $('#hint').hidden = false;
  hintTimer = setTimeout(hideHint, 9000);
}
function hideHint() {
  if ($('#hint').hidden) return;
  $('#hint').hidden = true; clearTimeout(hintTimer);
  try { localStorage.setItem('proof.hinted', '1'); } catch (e) { /* private window */ }
}
$('#names').addEventListener('click', () => setNames(!names));
$('#hold').addEventListener('click', () => {
  hold = !hold;
  if (!hold) wantShow = true;
  $('#hold').setAttribute('aria-pressed', String(hold));
  $('#hold').innerHTML = hold ? 'Resume' : 'Hold<span class="long"> this ledger</span>';
});
$('#sound').addEventListener('click', () => {
  if (sound.on) sound.disable(); else sound.enable();
  $('#sound').setAttribute('aria-pressed', String(sound.on));
});
$('#root-switch').addEventListener('click', () => {
  rootName = rootName === 'ripple' ? 'xrplf' : 'ripple';
  const u = new URL(location.href); u.searchParams.set('root', rootName); history.replaceState(null, '', u);
  $('#root-switch').textContent = `Trust ${TRUST_ROOTS[rootName === 'ripple' ? 'xrplf' : 'ripple'].name} instead`;
  show = null; ledgers.clear(); newest = 0;
  sky.clear();
  $('#lg-seq').textContent = '';
  for (const id of ['sigs', 'quorum', 'header']) row(id, 'pending', '', '');
  loadList();
});
$('#root-switch').textContent = `Trust ${TRUST_ROOTS[rootName === 'ripple' ? 'xrplf' : 'ripple'].name} instead`;
$('#tour-start').addEventListener('click', () => { if (tour) tour.start(); });
$('#tour-again').addEventListener('click', () => { if (tour) tour.start(); });
addEventListener('keydown', e => {
  if (e.target instanceof Element && e.target.closest('input, textarea')) return;
  if (tour && tour.on && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
  const k = e.key.toLowerCase();
  if (k === 'n') setNames(!names);
  else if (k === 'h') $('#hold').click();
  else if (k === '0') goHome();
  else if (k === '+' || k === '=') dolly(1 / 1.25);
  else if (k === '-' || k === '_') dolly(1.25);
  else if (k === 'arrowleft') orbit(-40, 0);
  else if (k === 'arrowright') orbit(40, 0);
  else if (k === 'arrowup') orbit(0, -30);
  else if (k === 'arrowdown') orbit(0, 30);
});

// what the tour may read and move
const tourApi = {
  state() {
    const L = show && ledgers.get(show.seq), a = L && L.acct;
    const key = list ? list.root : rootName, root = TRUST_ROOTS[key], other = TRUST_ROOTS[key === 'ripple' ? 'xrplf' : 'ripple'];
    let acct = null;
    if (watch) {
      const done = !!(show && show.acctDone && a);
      acct = { told: watch.told ? xrp(watch.told.drops) : null, seq: show && show.seq, why: a && a.why, proven: watch.proven,
               xrp: a && a.ok ? xrp(a.drops) : null,
               state: !done ? 'told' : a.ok ? 'proven' : a.absent ? 'absent' : 'failed' };
    }
    return {
      seq: show ? show.seq : null, count: show ? show.count : 0,
      total: list ? list.validators.length : 35, quorum: list ? list.quorum : 28,
      quorumReached: !!(show && show.quorumAt !== null),
      header: show && show.headerAt !== null && L && L.hdr ? L.hdr.hash : null,
      root: root.name, rootKey: root.key, other: other.name, rings: sky ? sky.rings.length : 0,
      acct, touch: coarse, stacked: document.documentElement.classList.contains('stacked'),
    };
  },
  name: nameOf,
  /** Fly to a sphere of the scene (centre, radius), seen from yaw and pitch, inside a box on screen. */
  frame(s, box) {
    const f = sky.frameSphere(s.at, s.r, box, s.yaw ?? HOME.yaw, s.pitch ?? HOME.pitch);
    Object.assign(view, f, { glide: true, moved: false });
  },
  fit(box) {
    const h = homeView(), f = box ? sky.frameSphere(h.centre, h.radius, box, h.yaw, h.pitch) : home;
    Object.assign(view, f, { target: f.target.slice(), lens: f.lens.slice(), glide: true, moved: false });
    $('#fit').hidden = true;
  },
  names(on) { if (on === undefined) return names; setNames(on); },
  screen: p => sky.project(p),
  size: (p, r) => { const a = sky.project(p), b = sky.project([p[0], p[1] + r, p[2]]); return Math.hypot(a[0] - b[0], a[1] - b[1]); },
  duck: on => sound.duck(on),
  lookup(addr) { $('#addr').value = addr; $('#addr-form').requestSubmit(); },
  n: () => (sky ? sky.n : 35),
  /** Clear the stage: the legend closes, the view resumes. */
  prepare() {
    if (!$('#legend').hidden) $('#help').click();
    if (hold) $('#hold').click();
    hideHint();
  },
};

// ── an account, proven ──────────────────────────────────────────────────────
// The relay's reading is shown at once, as an outline. Then, for each ledger
// this page proves, the relay fetches the nodes from that ledger's state root
// down to the account's entry; the worker hashes every one of them up to the
// state root in the checked header. Only then does the body light.
let watch = null;        // { addr, key, told: { drops, ledger } | null, proven }

function askProof(L) {
  if (!watch || !L.hdr || L.acctFor === watch.addr) return;
  if (show && L.seq < show.seq) return;            // already shown; never shown again
  const w = watch;
  L.acctFor = w.addr; L.acct = null;
  const failed = why => { if (watch === w && L.acctFor === w.addr) { L.acct = { ok: false, fetch: true, why }; late(L); } };
  fetch(`${RELAY}/path?key=${w.key}&ledger=${L.hdr.hash}`)
    .then(r => r.json())
    .then(p => {
      if (watch !== w) return;
      if (!p.nodes) return failed(p.error || 'no answer');
      worker.postMessage({ t: 'proof', seq: L.seq, addr: w.addr, stateRoot: L.hdr.stateRoot, nodes: p.nodes });
    })
    .catch(() => failed('the relay did not answer'));
}
/** A result for the ledger in view, after its turn has come: show it now. */
function late(L) { if (show && show.seq === L.seq && show.acctDone) paintAccount(L); }

function paintAccount(L) {
  const a = L.acct;
  if (!a || !watch) return;
  if (a.ok || a.absent) {
    const first = !watch.proven;
    watch.proven = { seq: L.seq, xrp: a.ok ? xrp(a.drops) : null, absent: !a.ok };
    sky.account({ addr: watch.addr, state: a.ok ? 'proven' : 'absent', path: a.path.filter(Boolean), seq: L.seq });
    acctTag(a.ok ? 'proven' : 'absent', a.ok ? `${xrp(a.drops)} XRP` : 'no such account', a.ok ? `proven, ledger ${hs(L.seq)}` : `proven missing, ledger ${hs(L.seq)}`);
    if (first) sound.chime();
  } else if (a.fetch && watch.proven) {
    // the relay could not fetch this ledger's proof: the last proof stands, under its own ledger's
    // number, until one checks again. A proof that fails its hashes is another matter: it goes back to told
  } else {
    told(L);
  }
  note(L);
  if (tour) tour.event('account');
}

/** The relay's reading, as an outline, with what became of this ledger's proof. */
function told(L) {
  const a = L && L.acct, t = watch.told;
  watch.proven = null;
  sky.account({ addr: watch.addr, state: 'told' });
  const why = a && !a.ok && !a.absent ? `not proven for ledger ${hs(L.seq)}` : 'the relay says; not yet proven here';
  acctTag('told', t ? `${xrp(t.drops)} XRP` : 'no such account', why);
}
function acctTag(state, amt, said) {
  const el = $('#acct-tag');
  el.dataset.state = state;
  el.querySelector('.said').textContent = said;
  el.querySelector('.amt').textContent = amt;
  el.querySelector('.who').textContent = `${watch.addr.slice(0, 8)}…${watch.addr.slice(-6)}`;
}

/** The words under the lookup box follow the proof of the ledger in view. */
function note(L) {
  const t = watch.told, a = L && L.acct;
  const said = t ? `${xrp(t.drops)} XRP, the relay says.` : `The relay found no such account.`;
  let s, path = '';
  if (a && a.ok) {
    s = `Proven in this browser for ledger ${hs(L.seq)}: the account’s entry hashes, through ${a.path.length - 1} inner nodes, ` +
        'up to the state root the validators signed. Its path from the root:';
    path = [...a.path.slice(0, -1), 'entry'].join(' → ');
  } else if (a && a.absent) {
    const other = a.path[a.path.length - 1] === '';   // the path ended at someone else's entry
    s = `Ledger ${hs(L.seq)} has no such account, proven in this browser: ` +
        (other ? 'the only entry where it would sit belongs to another account.' : 'the branch where it would sit is empty.') + ' Its path from the root:';
    path = a.path.filter(Boolean).join(' → ') + ' → nothing';
  } else if (a && a.fetch && watch.proven) {
    const p = watch.proven;
    s = `${p.absent ? 'Proven missing' : `${p.xrp} XRP, proven`} for ledger ${hs(p.seq)}. The proof for ledger ${hs(L.seq)} could not be fetched (${a.why}); the next ledger will try again.`;
    path = $('#addr-path').textContent;
  } else if (a) {
    s = `${said} Not proven for ledger ${hs(L.seq)}: ${a.why}. It stays an outline.`;
  } else {
    s = `${said} Checking it against the next ledger this page proves…`;
  }
  $('#addr-note').textContent = s;
  $('#addr-path').textContent = path;
}

$('#addr-form').addEventListener('submit', async e => {
  e.preventDefault();
  const addr = $('#addr').value.trim();
  if (/^[0-9A-Fa-f]{64}$/.test(addr)) { proveTx(addr.toUpperCase()); return; }
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(addr)) { $('#addr-note').textContent = 'That is neither an XRP Ledger address (they start with r) nor a transaction hash (64 characters, 0-9 and A-F).'; return; }
  let key;
  try { key = accountKey(addr); } catch (err) {
    $('#addr-note').textContent = 'That address does not check out: its last characters are a checksum, and they do not match. Look for a typo.';
    return;
  }
  $('#addr-note').textContent = 'Asking the relay…'; $('#addr-path').textContent = '';
  let a;
  try { a = await fetch(`${RELAY}/account?addr=${encodeURIComponent(addr)}`).then(r => r.json()); }
  catch (err) { a = { error: 'the relay did not answer' }; }
  // the proof does not need the relay's reading; it is only something to show at once
  watch = { addr, key, told: a.error ? null : { drops: a.balance, ledger: a.ledger }, toldError: a.error, proven: null };
  for (const L of ledgers.values()) { L.acctFor = null; L.acct = null; }
  if (show) show.acctDone = show.headerAt !== null;   // past the heart already: light it as soon as it checks
  told();
  note();
  for (const L of ledgers.values()) askProof(L);
  if (tour) tour.event('lookup');
});

// ── receipts ────────────────────────────────────────────────────────────────
// A transaction hash in the lookup box (or ?tx= in the address) is proven into
// a receipt: evidence gathered from the relay, checked in the worker by the
// same code that checks a receipt file dropped on the page, then drawn and
// wrapped in a PDF with the evidence attached.
let wantTx = /^[0-9A-Fa-f]{64}$/.test(new URLSearchParams(location.search).get('tx') || '') ? new URLSearchParams(location.search).get('tx').toUpperCase() : null;
let receiptJobs = 0, current = null;
// the receipt's look: Deep Field's (this page's) or engraved; ?style=engraved picks the latter
let receiptStyle = (() => {
  const q = new URLSearchParams(location.search).get('style');
  if (q === 'engraved' || q === 'space') return q;
  try { return localStorage.getItem('proof.receiptStyle') === 'engraved' ? 'engraved' : 'space'; } catch (e) { return 'space'; }
})();
function styleButtons() {
  document.querySelectorAll('[data-style]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.style === receiptStyle)));
}
document.querySelectorAll('[data-style]').forEach(b => b.addEventListener('click', () => {
  receiptStyle = b.dataset.style; styleButtons();
  try { localStorage.setItem('proof.receiptStyle', receiptStyle); } catch (e) { /* storage blocked */ }
}));
styleButtons();
const receiptWait = new Map();
const checkReceipt = bundle => new Promise(done => { const id = ++receiptJobs; receiptWait.set(id, done); worker.postMessage({ t: 'receipt', id, bundle }); });
const pause = ms => new Promise(r => setTimeout(r, ms));

/** The newest ledger proven here, with the signatures that proved it. */
function anchorLedger() {
  let best = null;
  for (const L of ledgers.values()) if (L.proven && L.hdr && L.header && (!best || L.seq > best.seq)) best = L;
  if (!best) return null;
  return { seq: best.seq, hash: best.hdr.hash, header: best.header,
           validations: best.checks.filter(c => c.hash === best.hdr.hash && c.data).map(c => c.data) };
}

async function proveTx(hash) {
  receiptOpen(`Proving transaction ${hash.slice(0, 8)}…${hash.slice(-6)}`);
  $('#addr-note').textContent = 'Proving that transaction…'; $('#addr-path').textContent = '';
  try {
    let bundle = null;
    for (let tries = 0; !bundle; tries++) {
      let anchor = anchorLedger();
      for (let i = 0; !anchor && i < 40; i++) { receiptStep('Waiting for this page to prove its first ledger…'); await pause(500); anchor = anchorLedger(); }
      if (!anchor) throw new Error('no ledger has been proven here yet, so there is nothing to anchor the receipt to');
      try { bundle = await buildReceipt({ relay: RELAY, txHash: hash, anchor, list: listRaw, step: receiptStep }); }
      catch (err) {
        // a transaction newer than the ledger on hand: wait for the next one to be proven
        if (!/newer than the last ledger/.test(err.message) || tries > 4) throw err;
        receiptStep('That transaction is newer than the last ledger proven here. Waiting for the next…'); await pause(3500);
      }
    }
    receiptStep('Checking every signature and hash…');
    const v = await checkReceipt(bundle);
    if (!v.ok) throw new Error(`the evidence does not check out: ${v.why}`);
    receiptShow(v, bundle, 'Proven in this browser, just now');
    $('#addr-note').textContent = 'Proven. The receipt is open.';
  } catch (err) {
    receiptFail(`Could not prove that transaction: ${err.message}.`);
    $('#addr-note').textContent = '';
  }
}

async function checkFile(file) {
  receiptOpen(`Checking ${file.name}`);
  try {
    const bundle = readEvidence(new Uint8Array(await file.arrayBuffer()));
    receiptStep('Checking every signature and hash in it…');
    const v = await checkReceipt(bundle);
    if (!v.ok) return receiptFail(`This receipt does not check out: ${v.why}.`);
    receiptShow(v, bundle, `Checked in this browser, from ${file.name}`);
  } catch (err) { receiptFail(`This file cannot be checked: ${err.message}.`); }
}

function receiptOpen(title) {
  current = null;
  const r = $('#receipt');
  r.hidden = false; r.dataset.state = 'working'; delete r.dataset.failed;
  $('#rc-kicker').textContent = title;
  for (const id of ['#rc-lead', '#rc-amount', '#rc-issuer', '#rc-parties', '#rc-outcome', '#rc-proof']) $(id).textContent = '';
  $('#rc-rows').replaceChildren();
  $('#rc-pdf').hidden = true;
  receiptStep('Asking the relay…');
}
function receiptStep(s) { $('#rc-steps').textContent = s; }
function receiptFail(s) {
  $('#receipt').dataset.state = 'failed';
  $('#rc-kicker').textContent = 'Not proven';
  receiptStep(s);
}
function receiptShow(v, bundle, kicker) {
  current = { v, bundle };
  const tx = v.tx, h = headline(tx), r = $('#receipt');
  r.dataset.state = 'proven';
  if (tx.succeeded) delete r.dataset.failed; else r.dataset.failed = '';
  $('#rc-kicker').textContent = kicker;
  $('#rc-lead').textContent = h.lead;
  $('#rc-amount').textContent = h.amount ? amountText(h.amount, ' ') : tx.type;
  $('#rc-issuer').textContent = h.amount && h.amount.issuer ? `issued by ${h.amount.issuer}` : h.then || '';
  $('#rc-parties').textContent = tx.destination ? `from ${tx.account} to ${tx.destination}` : `from ${tx.account}`;
  $('#rc-outcome').textContent = tx.succeeded ? 'Succeeded' : `Failed: ${tx.result}. The fee was still charged.`;
  const rows = [['Transaction', v.hash], ['Ledger', `${hs(v.ledger.seq)}, closed ${utc(v.ledger.close)}`],
                ['Fee', amountText(tx.fee, ' ')]];
  if (tx.destinationTag !== null) rows.push(['Destination tag', String(tx.destinationTag)]);
  if (tx.invoiceId) rows.push(['Invoice ID', tx.invoiceId]);
  if (tx.delivered && tx.amount && amountText(tx.delivered) !== amountText(tx.amount)) rows.push(['Amount sent', amountText(tx.amount, ' ')]);
  for (const m of tx.memos) rows.push([m.type && m.type.length < 24 ? `Memo (${m.type})` : 'Memo', m.data || '']);
  $('#rc-rows').replaceChildren(...rows.flatMap(([k, val]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = k; dd.textContent = val;
    return [dt, dd];
  }));
  $('#rc-proof').textContent = `Ledger ${hs(v.anchor.seq)} was signed by ${v.anchor.signers} of the ${v.anchor.listed} validators on ${v.publisher}’s list (a quorum is ${v.anchor.quorum}). ` +
    (v.steps === 0 ? 'The transaction is in that ledger’s own transaction tree.'
      : `From it, ${v.steps === 1 ? 'its record of earlier ledgers' : `its record of earlier ledgers and ${v.steps - 1} more headers, each the parent of the one before,`} lead to ledger ${hs(v.ledger.seq)}, and that ledger’s transaction tree to the transaction.`);
  $('#rc-pdf').hidden = false;
  receiptStep('');
}
$('#rc-close').addEventListener('click', () => { $('#receipt').hidden = true; current = null; });
$('#rc-pdf').addEventListener('click', async () => {
  if (!current) return;
  const { v, bundle } = current;
  const space = receiptStyle === 'space';
  receiptStep(space ? 'Drawing the receipt…' : 'Engraving the receipt…');
  await pause(30);
  if (space) await spaceFonts();
  else { try { await Promise.all(['500', '600', '700', '800'].map(w => document.fonts.load(`${w} 40px 'Bodoni Moda'`)).concat(document.fonts.load(`italic 500 40px 'Bodoni Moda'`))); } catch (e) { /* the system serif */ } }
  const c = space ? drawSpaceReceipt(v) : drawReceipt(v);
  const jpeg = new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/jpeg', 0.84))).arrayBuffer());
  // the engraved receipt carries its words as a footnote; the Deep Field one lays them under its picture
  const pdf = receiptPdf({ jpeg, width: RW, height: RH, title: `XRPL transaction receipt ${v.hash.slice(0, 16)}`,
    evidence: new TextEncoder().encode(JSON.stringify(bundle)),
    ...(space ? { layer: c.layer } : { lines: [`XRPL transaction ${v.hash}, ledger ${v.ledger.seq} (${v.ledger.hash})`,
            'To check this receipt, drop this file on https://v2v.halcyon-names.io/proof/ . Its evidence is attached (proof-receipt.json).'] }) });
  const url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `xrpl-receipt-${v.hash.slice(0, 12).toLowerCase()}${space ? '-deep-field' : ''}.pdf` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  perf.lastPdf = pdf;                                    // test hook
  receiptStep('Downloaded.');
});
// a receipt dropped anywhere on the page, or picked with the button, is checked
$('#check-receipt').addEventListener('click', () => $('#receipt-file').click());
$('#receipt-file').addEventListener('change', e => { const f = e.target.files[0]; if (f) checkFile(f); e.target.value = ''; });
addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); document.body.classList.add('dropping'); } });
addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
addEventListener('drop', e => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault(); document.body.classList.remove('dropping');
  const f = e.dataTransfer.files[0];
  if (f) checkFile(f);
});
perf.proveTx = proveTx; perf.checkBytes = (bytes, name = 'receipt.pdf') => checkFile(new File([bytes], name));

boot();
