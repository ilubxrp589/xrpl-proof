/* Proof: the page. It fetches raw bytes from an untrusted relay, has the
 * worker check them, and inks the sheet only with what came back verified.
 *
 * The display runs one ledger behind the network: a ledger's validations
 * keep arriving after it closes, so ledger N is printed once N+1 has closed,
 * and each signature inks in the order, and at the pace, it actually arrived.
 * Anything that arrives later still inks, live. */
import { Renderer, PART, N_COLS, BASE_AT, SHEET } from './render.js';
import { buildStatic, Dynamic, xrpText, W as SW, H as SH, L as SL } from './note.js';
import { TRUST_ROOTS, accountKey } from './verify.js';
import { Sound } from './audio.js';
import { Tour } from './tour.js';

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

// ── state the renderer reads ────────────────────────────────────────────────
const st = {
  time: 0, mode: 0, loupe: false, flip: 0, lift: 0,
  mouse: [-0.35, 0.45], px: [innerWidth / 2, innerHeight / 2],
  tiltX: 0, tiltY: 0, templeYaw: 0,
  ink: new Float32Array(41),
  glory: 0, quorum: 0, loupeZoom: 3.2, loupeR: 150,
  zoom: 1, pan: [0, 0, 0], lens: [0, 0],
};
// the view: scroll zooms toward the pointer, drag moves over the sheet
const ZOOM_MAX = 6;
const view = { zoom: 1, pan: [0, 0, 0], lens: [0, 0], drag: null, glide: false };   // glide: the tour's slower camera
const target = { ink: new Float32Array(41), glory: 0, quorum: 0, flip: 0, mouse: [-0.35, 0.45] };
target.ink[PART.GROUND] = 1; target.ink[PART.CORNER] = 1;

let renderer, dyn, dyn_, sound = new Sound(), tour = null;
let list = null, rootName = new URLSearchParams(location.search).get('root') === 'xrplf' ? 'xrplf' : 'ripple';
const ledgers = new Map();        // seq → buffered, checked material
let show = null, hold = false, proven = 0, ws = null;
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
    // count those toward a quorum): never inked
    if (r.idx < 0 || !r.ok || !r.full) return;
    const L = ledger(r.seq);
    if (L.checks.some(c => c.idx === r.idx && c.hash === r.hash)) return;
    const c = { idx: r.idx, hash: r.hash, sig: r.sig, at: m.at };
    L.checks.push(c);
    L.byHash.set(r.hash, (L.byHash.get(r.hash) || 0) + 1);
    settle(L);
    if (show && show.seq === r.seq) show.queue.push({ ...c, t: show.elapsed });
  } else if (m.t === 'header') {
    const L = ledger(m.seq);
    L.hdr = m.res;
    settle(L);
    askProof(L);
  } else if (m.t === 'proof') {
    const L = ledgers.get(m.seq);
    if (!L || !watch || m.addr !== watch.addr) return;
    L.acct = m.res;
    if (show && show.seq === L.seq && show.acctDone) paintAccount(L);   // arrived late: ink it now
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
    $('#tally').textContent = `${fmt(proven)} ledger${proven === 1 ? '' : 's'} proven in this browser since you arrived.`;
  }
}

// ── the relay ───────────────────────────────────────────────────────────────
async function boot() {
  try {
    await Promise.all(['500', '600', '700', '800'].map(w => document.fonts.load(`${w} 40px 'Bodoni Moda'`)));
    await document.fonts.load(`italic 500 40px 'Bodoni Moda'`);
  } catch (e) { /* fall back to the system serif */ }
  try {
    renderer = new Renderer($('#gl'));
  } catch (e) {
    return fail(String(e.message || e));
  }
  loadList();
}

async function loadList() {
  setStatus(`Checking the validator list against ${TRUST_ROOTS[rootName].name}…`);
  try {
    const [vl, mf] = await Promise.all([
      fetch(`${RELAY}/vl?src=${rootName}`).then(r => r.json()),
      fetch(`${RELAY}/manifests`).then(r => r.json()),
    ]);
    worker.postMessage({ t: 'list', body: vl, manifests: mf.manifests, root: rootName });
  } catch (e) {
    fail('The relay is not answering, so there is nothing to check yet. It will be retried in ten seconds.');
    setTimeout(loadList, 10000);
  }
}

function start() {
  const root = TRUST_ROOTS[list.root];
  const sheet = buildStatic({ trustRoot: root.key, trustName: root.name, validators: list.validators, quorum: list.quorum });
  dyn = dyn_ = new Dynamic(list.validators, list.quorum);
  renderer.setSheet(sheet, dyn);
  target.ink[PART.STEPS] = 1;                    // the list is verified: the steps are cut
  // the legend's numbers come from the list this page verified, not from a guess
  document.querySelectorAll('[data-n]').forEach(e => { e.textContent = list.validators.length; });
  document.querySelectorAll('[data-q]').forEach(e => { e.textContent = list.quorum; });
  $('#root-name').textContent = root.name;
  $('#root-key').textContent = root.key.slice(0, 10) + '…' + root.key.slice(-8);
  $('#root-key').title = root.key;
  document.body.classList.add('live');
  setStatus(`The list checks out: ${list.validators.length} validators, signed by ${root.name}. Waiting for the next ledger…`);
  connect();
  if (!tour) {
    tour = new Tour(tourApi);
    if (!Tour.seen() || new URLSearchParams(location.search).has('tour')) tour.start();
  }
  if (!started) { started = true; requestAnimationFrame(tick); }
}
let started = false;

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
      // a new close means the one before it has its signatures in: print next
      if (!f.replay) wantShow = true;
    } else if (f.t === 'val') {
      worker.postMessage({ t: 'val', data: f.data, at: f.at, replay: !!f.replay });
    }
  };
  ws.onopen = () => { wantShow = true; };
  ws.onclose = () => { setStatus('The relay closed the connection. Reconnecting…'); setTimeout(connect, 3000); };
}
let newest = 0, wantShow = false, pulling = null, lastClose = 0, skew = 0;

// ── printing one ledger ─────────────────────────────────────────────────────
/** The ledger to print next: the newest one older than the latest close that
 *  already has checked signatures. The checks can trail the closes by a few
 *  seconds on a slow machine, so this is chosen when it is time to print, not
 *  when the close arrives. */
function pickNext() {
  let best = null;
  for (const [seq, L] of ledgers)
    if (seq < newest && L.checks.length && (!show || seq > show.seq) && (!best || seq > best)) best = seq;
  return best;
}

function begin(seq) {
  const L = ledgers.get(seq);
  if (!L) return;
  dyn.ledger(seq);
  for (let i = 0; i < N_COLS; i++) { target.ink[i] = 0; st.ink[i] = 0; }
  for (const p of [PART.BEAM, PART.DOME, PART.LANTERN]) { target.ink[p] = 0; st.ink[p] = 0; }
  target.glory = 0; st.glory = 0; target.quorum = 0;
  // replay each check at the offset it actually arrived after the close
  const span = reduced ? 0.001 : 2.8;
  const offs = L.checks.map(c => Math.max(0, (c.at - L.closeAt) / 1000));
  const maxOff = Math.max(0.5, ...offs);
  const scale = Math.min(1, span / maxOff);
  show = { seq, elapsed: 0, queue: L.checks.map((c, i) => ({ ...c, t: 0.15 + offs[i] * scale })),
           signed: new Set(), drawn: new Set(), count: 0, quorumAt: null, quorumHash: null, headerAt: null,
           mismatch: false, acctDone: false };
  if (watch) { pencil(); askProof(L); }
  dyn.stepTicks(3);                      // the paper, the list and the keys already hold
  if (tour) tour.event('begin', { seq });
  if (!hintShown) { hintShown = true; setTimeout(showHint, 2500); }
}
let hintShown = false;

function step(dt) {
  if (wantShow && !pulling && !hold) {
    const next = pickNext();
    if (next !== null) { pulling = { seq: next, t: 0 }; wantShow = false; }
  }
  if (pulling) {
    // the finished proof lifts from the press and the next is laid down
    pulling.t += dt;
    const T = reduced ? 0.01 : 0.55;
    st.lift = Math.sin(Math.min(1, pulling.t / T) * Math.PI) * 1.4 / st.zoom;
    if (!pulling.swapped && pulling.t >= T / 2) { pulling.swapped = true; begin(pulling.seq); }
    if (pulling.t >= T) { st.lift = 0; pulling = null; }
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
    if (ev.hash !== hash || show.drawn.has(ev.idx)) continue;
    show.drawn.add(ev.idx);
    dyn.signed(ev.idx, ev.sig);          // the signature's own bytes, straight from the worker
    sound.pluck(ev.idx);
    recount();
    if (tour) tour.event('signed', { idx: ev.idx });
  }
  // the dome: the header must hash to exactly what the quorum signed
  if (show.quorumAt !== null && show.headerAt === null && L.hdr && L.hdr.hash === show.quorumHash) {
    show.headerAt = show.elapsed;
    target.ink[PART.DOME] = 1; target.glory = 1;
    dyn.header(L.hdr);
    dyn.stepTicks(6);
    sound.bell();
    if (tour) tour.event('header');
  }
  // the lantern: the watched account's entry hashes up to this header's state root
  if (watch && show.headerAt !== null && !show.acctDone && show.elapsed >= show.headerAt + 0.8) {
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

/** Recount from what has arrived: the signatures on the current hash. Column
 *  ink follows the same set. */
function recount() {
  if (!show) return;
  show.signed = new Set(show.queue.filter(ev => ev.fired && ev.hash === show.hash).map(ev => ev.idx));
  for (let i = 0; i < N_COLS; i++) target.ink[i] = show.signed.has(i) ? 1 : 0;
  const n = show.signed.size;
  if (n !== show.count || !show.counted) { show.count = n; show.counted = true; dyn.count(n); }
  const standing = show.quorumAt !== null;
  if (n >= list.quorum && (!standing || show.quorumHash !== show.hash)) {
    show.quorumAt = show.elapsed; show.quorumHash = show.hash;
    show.headerAt = null; show.mismatch = false;
    target.ink[PART.BEAM] = 1; target.quorum = 1;
    dyn.stepTicks(5);
    sound.quorum();
    if (tour) tour.event('quorum');
  } else if (n < list.quorum && standing) {
    // the header came in, and it is not the ledger they signed: the roof comes down
    show.quorumAt = null; show.quorumHash = null; show.headerAt = null; show.mismatch = false;
    target.ink[PART.BEAM] = 0; target.ink[PART.DOME] = 0; target.quorum = 0; target.glory = 0;
    if (show.acctDone) {
      // the state root is no longer vouched for, so neither is the balance
      show.acctDone = false; target.ink[PART.LANTERN] = 0;
      dyn.clearAccount();
      if (watch) { pencil(); note(); }
    }
    sound.thud();
  }
}

// ── status line ─────────────────────────────────────────────────────────────
let lastStatus = '';
function status() {
  // say so when the relay's node goes quiet, rather than showing an old proof as if it were current
  const quiet = lastClose ? (performance.now() - lastClose) / 1000 : 0;
  let s;
  if (quiet > 20) {
    const age = quiet < 120 ? `${Math.round(quiet)} seconds` : `${Math.round(quiet / 60)} minutes`;
    s = `The relay's newest ledger is ${age} old; its node may have fallen behind.` +
        (show ? ` Ledger ${fmt(show.seq)} stays on the press until a new one arrives.` : '');
  } else if (!show) return;
  else {
    s = `Ledger ${fmt(show.seq)}. ${show.count} of ${list.validators.length} signatures checked in this browser`;
    if (show.mismatch) s += '. The relay sent a header that does not hash to what the quorum signed, so this ledger is not proven.';
    else if (show.quorumAt !== null && show.headerAt !== null) s += '; quorum reached, and the header hashes to what they signed.';
    else if (show.quorumAt !== null) s += '; quorum reached.';
    else s += '.';
  }
  if (s !== lastStatus) { lastStatus = s; setStatus(s); }
}
setInterval(() => { if (list) status(); }, 2000);
function setStatus(s) { $('#status').textContent = s; }
function fail(msg, steps) {
  setStatus(msg);
  document.body.classList.add('failed');
  if (steps) console.warn(steps);
}

// ── the frame ───────────────────────────────────────────────────────────────
let last = performance.now();
// a slow renderer (software GL in a test harness) may ask for bigger steps
const DT_MAX = Math.min(4, Number(new URLSearchParams(location.search).get('dtmax')) || 0.1);
const perf = window.__proof = { frames: 0, ms: 0, tour: () => tour,
  state: () => ({ list: !!list, show: show && show.seq, pulling, hold, newest, wantShow,
                  ledgers: [...ledgers].map(([k, L]) => [k, L.checks.length, !!L.hdr, L.proven]),
                  watch: watch && watch.addr, lantern: target.ink[PART.LANTERN],
                  acct: show && ledgers.get(show.seq) ? ledgers.get(show.seq).acct : null }) };
function tick(now) {
  const dt = Math.min(DT_MAX, (now - last) / 1000);
  perf.frames++; perf.ms = now - last;
  try { frame(dt); } catch (err) {
    // one bad frame must not stop the page: log it once, keep printing
    if (!perf.err) console.error(err);
    perf.err = (perf.err || 0) + 1;
  }
  last = now;
  requestAnimationFrame(tick);
}
function frame(dt) {
  st.time += dt;
  step(dt);
  const k = 1 - Math.exp(-dt * 5.5), kin = 1 - Math.exp(-dt * (reduced ? 60 : 4.2));
  for (let i = 0; i < 41; i++) st.ink[i] += (target.ink[i] - st.ink[i]) * kin;
  st.glory += (target.glory - st.glory) * (1 - Math.exp(-dt * 1.2));
  st.quorum += (target.quorum - st.quorum) * k;
  st.flip += (target.flip - st.flip) * (1 - Math.exp(-dt * 4));
  st.mouse[0] += (target.mouse[0] - st.mouse[0]) * k;
  st.mouse[1] += (target.mouse[1] - st.mouse[1]) * k;
  st.tiltY = reduced ? 0 : -st.mouse[0] * 0.07 / st.zoom;
  st.tiltX = reduced ? 0 : st.mouse[1] * 0.04 / st.zoom;
  const kz = 1 - Math.exp(-dt * (reduced ? 60 : view.glide ? 2.6 : 12));
  st.zoom += (view.zoom - st.zoom) * kz;
  for (let i = 0; i < 3; i++) st.pan[i] += (view.pan[i] - st.pan[i]) * kz;
  for (let i = 0; i < 2; i++) st.lens[i] += (view.lens[i] - st.lens[i]) * kz;
  $('#fit').hidden = view.zoom < 1.02;
  document.body.classList.toggle('zoomed', st.zoom > 1.06);
  st.templeYaw = reduced ? 0 : 0.16 * Math.sin(st.time * 0.07);
  if (dyn) renderer.frame(st);
  if (tour) tour.frame();
}

// ── input ───────────────────────────────────────────────────────────────────
const MODES = ['daylight', 'raking', 'backlight', 'ultraviolet'];
function setMode(m) {
  st.mode = m;
  document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.mode === m)));
  document.body.dataset.light = MODES[m];
}
function setLoupe(on) {
  st.loupe = on;
  $('#loupe').setAttribute('aria-pressed', String(on));
  document.body.classList.toggle('loupe', on);
}
function flip() {
  target.flip = target.flip > 0.5 ? 0 : 1;
  $('#turn').setAttribute('aria-pressed', String(target.flip > 0.5));
}

/** Zoom by k toward a pointer position: a homothety about the point of the
 *  sheet under the pointer, so that point stays put while everything grows. */
function zoomAt(px, py, k) {
  if (!renderer) return;
  const z0 = view.zoom, z1 = Math.min(ZOOM_MAX, Math.max(1, z0 * k));
  if (Math.abs(z1 - z0) < 1e-4) return;
  const probe = { ...st, zoom: z0, pan: view.pan };
  const P = renderer.sheetHit(probe, px, py).world;
  const r = z0 / z1, at = BASE_AT.map((b, i) => b + view.pan[i]);
  const next = at.map((a, i) => P[i] + r * (a - P[i]) - BASE_AT[i]);
  view.zoom = z1;
  view.pan = renderer.clampPan(st, next, z1);
  view.glide = false;
  hideHint();
}
function fitSheet(glide = false) { view.zoom = 1; view.pan = [0, 0, 0]; view.lens = [0, 0]; view.glide = glide; }

/** The whole sheet, inside a box on screen: as it is if it already fits, else
 *  drawn back and slid over by a lens shift (a phone on its side, where the
 *  tour's panel takes the right half). */
function fitInto(box) {
  fitSheet(true);
  if (!renderer || !box) return;
  const probe = z => ({ ...st, flip: 0, lift: 0, zoom: z, pan: [0, 0, 0], lens: [0, 0],
    tiltX: reduced ? 0 : target.mouse[1] * 0.04 / z, tiltY: reduced ? 0 : -target.mouse[0] * 0.07 / z });
  const bbox = z => {
    const p = [[0, 0], [SW, 0], [0, SH], [SW, SH]].map(([x, y]) => renderer.toScreen(probe(z), x, y));
    const xs = p.map(q => q[0]), ys = p.map(q => q[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const b1 = bbox(1);
  if (b1[0] >= box[0] && b1[1] >= box[1] && b1[2] <= box[2] && b1[3] <= box[3]) return;
  const z = Math.min(1, 0.97 * Math.min((box[2] - box[0]) / (b1[2] - b1[0]), (box[3] - box[1]) / (b1[3] - b1[1])));
  const b = bbox(z);
  view.zoom = z;
  view.lens = [((box[0] + box[2]) / 2 - (b[0] + b[2]) / 2) / (innerWidth / 2),
               ((b[1] + b[3]) / 2 - (box[1] + box[3]) / 2) / (innerHeight / 2)];
}

/** Frame a rectangle of the sheet (sheet px) inside a box on screen (CSS px):
 *  zoom until it fills the box, then slide the view until its centre sits at
 *  the box's centre. The tour's camera. */
function frameRect(r, box, maxZoom = 3.2) {
  if (!renderer) return;
  // the tilt follows the lamp, and eases with the zoom: frame with where it will settle
  const aim = target.mouse;
  const probe = (z, pan = [0, 0, 0]) => ({ ...st, flip: 0, lift: 0, zoom: z, pan, lens: [0, 0],
    tiltX: reduced ? 0 : aim[1] * 0.04 / z, tiltY: reduced ? 0 : -aim[0] * 0.07 / z });
  const p1 = probe(1);
  const pts = [[r[0], r[1]], [r[0] + r[2], r[1]], [r[0], r[1] + r[3]], [r[0] + r[2], r[1] + r[3]]]
    .map(([x, y]) => renderer.toScreen(p1, x, y));
  const w1 = Math.max(...pts.map(p => p[0])) - Math.min(...pts.map(p => p[0]));
  const h1 = Math.max(...pts.map(p => p[1])) - Math.min(...pts.map(p => p[1]));
  const z = Math.min(maxZoom, Math.max(1, 0.94 * Math.min((box[2] - box[0]) / w1, (box[3] - box[1]) / h1)));
  const P = renderer.sheetPoint(probe(z), r[0] + r[2] / 2, r[1] + r[3] / 2);
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  let pan = P.map((p, i) => p - BASE_AT[i]);
  for (let k = 0; k < 3; k++) {
    pan = renderer.clampPan(st, pan, z);
    const b = renderer.sheetHit(probe(z, pan), cx, cy).world;
    pan = pan.map((p, i) => p + P[i] - b[i]);
  }
  view.zoom = z; view.pan = renderer.clampPan(st, pan, z); view.lens = [0, 0]; view.glide = true;
}

/** Swing the lamp over a part of the sheet (sheet px), in the current light:
 *  the inverse of where frame() puts the lamp for a pointer position. */
function aimLamp(r) {
  const lx = ((r[0] + r[2] / 2) / SW - 0.5) * SHEET[0], ly = (0.5 - (r[1] + r[3] / 2) / SH) * SHEET[1];
  const [nx, ny] = st.mode === 1 ? [lx / 60, ly / 30] : st.mode === 2 ? [lx / 18, ly / 12] : [(lx + 6) / 52, (ly - 16) / 24];
  target.mouse = [Math.max(-1, Math.min(1, nx)), Math.max(-1, Math.min(1, ny))];
}

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
               state: !done ? 'pencil' : a.ok ? 'ink' : a.absent ? 'absent' : 'failed' };
    }
    return {
      seq: show ? show.seq : null, count: show ? show.count : 0,
      total: list ? list.validators.length : 35, quorum: list ? list.quorum : 28,
      quorumReached: !!(show && show.quorumAt !== null),
      header: show && show.headerAt !== null && L && L.hdr ? L.hdr.hash : null,
      root: root.name, rootKey: root.key, other: other.name,
      acct,
      touch: coarse, stacked: !!(renderer && renderer.stacked),
    };
  },
  name: i => (list && list.validators[i] ? list.validators[i].domain || list.validators[i].master.slice(0, 10) + '…' : ''),
  frame(rect, box) { aimLamp(rect); frameRect(rect, box); },
  fit(box) { target.mouse = [-0.35, 0.45]; fitInto(box); },
  mode(m) { if (m === undefined) return st.mode; setMode(m); },
  screen: (x, y) => renderer.toScreen(st, x, y),
  flipped: () => st.flip > 0.5,
  duck: on => sound.duck(on),
  lookup(addr) { $('#addr').value = addr; $('#addr-form').requestSubmit(); },
  /** Clear the stage: the legend closes, printing resumes, the front faces up. */
  prepare() {
    if (!$('#legend').hidden) $('#help').click();
    if (hold) $('#hold').click();
    if (target.flip > 0.5) flip();
    setLoupe(false); hideHint();
  },
};
$('#tour-start').addEventListener('click', () => { if (tour) tour.start(); });
$('#tour-again').addEventListener('click', () => { if (tour) tour.start(); });

/** Slide the paper so the point under (x0, y0) comes to (x1, y1). */
function panBy(x0, y0, x1, y1) {
  const probe = { ...st, zoom: view.zoom, pan: view.pan };
  const a = renderer.sheetHit(probe, x0, y0).world, b = renderer.sheetHit(probe, x1, y1).world;
  view.pan = renderer.clampPan(st, view.pan.map((p, i) => p + a[i] - b[i]), view.zoom);
  st.pan = view.pan.slice(); view.glide = false;
  hideHint();
}
// fingers on the sheet: one pans (when zoomed) or taps; two pinch about their
// midpoint and move the paper with it
const fingers = new Map();
let pinch = null, lastTap = null;
const pair = () => {
  const [a, b] = [...fingers.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
};
addEventListener('pointermove', e => {
  st.px = [e.clientX, e.clientY];
  if (fingers.has(e.pointerId)) fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && fingers.size >= 2) {
    const m = pair();
    if (pinch.d > 8 && m.d > 8) zoomAt(m.x, m.y, m.d / pinch.d);
    if (view.zoom > 1.01) panBy(pinch.x, pinch.y, m.x, m.y);
    pinch = m;
    return;
  }
  const d = view.drag;
  if (d && d.id === e.pointerId) {
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > (e.pointerType === 'mouse' ? 4 : 10)) d.moved = true;
    // the paper follows the pointer; with the loupe out, a finger moves the loupe instead
    if (d.moved && view.zoom > 1.01 && !(st.loupe && e.pointerType !== 'mouse')) panBy(d.lx, d.ly, e.clientX, e.clientY);
    d.lx = e.clientX; d.ly = e.clientY;
    if (e.pointerType === 'mouse') return;   // the lamp holds still while you drag
  }
  target.mouse = [(e.clientX / innerWidth) * 2 - 1, 1 - (e.clientY / innerHeight) * 2];
});
$('#gl').addEventListener('pointerdown', e => {
  if (e.pointerType === 'touch') {
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fingers.size === 2) {
      // a second finger: this is a pinch, and the first finger's drag is over
      pinch = pair();
      if (view.drag) view.drag.pinched = true;
      lastTap = null;
      return;
    }
  }
  if (e.button !== 0 || fingers.size > 1) return;
  view.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false };
  try { $('#gl').setPointerCapture(e.pointerId); } catch (err) { /* not a live pointer */ }
});
/** Two taps in quick succession zoom in on the spot, or back out to the whole
 *  sheet. Timed by the events' own stamps: on a busy phone the handlers can
 *  run further apart than the taps were. */
function tap(x, y, now) {
  if (lastTap && now - lastTap.t < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 36) {
    lastTap = null;
    if (view.zoom > 1.05) fitSheet(true); else { zoomAt(x, y, 2.6); view.glide = true; }
    hideHint();
    return;
  }
  lastTap = { t: now, x, y };
}
const endDrag = e => {
  fingers.delete(e.pointerId);
  if (fingers.size < 2) pinch = null;
  const d = view.drag;
  if (!d || d.id !== e.pointerId) return;
  view.drag = null;
  document.body.classList.remove('dragging');
  // a tap, not a drag or a pinch
  if (!d.moved && !d.pinched && e.type === 'pointerup' && e.pointerType !== 'mouse' && renderer && target.flip < 0.5) tap(e.clientX, e.clientY, e.timeStamp);
};
$('#gl').addEventListener('pointerup', endDrag);
$('#gl').addEventListener('pointercancel', endDrag);
$('#gl').addEventListener('pointermove', () => { if (view.drag && view.drag.moved) document.body.classList.add('dragging'); });
/** Test hook: every printed layer composed flat at full size, as a PNG data
 *  URL, so alignment can be checked without perspective or lighting. */
perf.flat = (side = 'front') => {
  const root = TRUST_ROOTS[list.root];
  const sh = buildStatic({ trustRoot: root.key, trustName: root.name, validators: list.validators, quorum: list.quorum });
  const plate = side === 'front' ? sh.plate : sh.back;
  const c = document.createElement('canvas'); c.width = SW; c.height = SH;
  const g = c.getContext('2d');
  const out = g.createImageData(SW, SH), o = out.data, p = plate.data;
  const dyn = (side === 'front' ? dyn_.c : dyn_.bk).getContext('2d').getImageData(0, 0, SW, SH).data;
  const foil = side === 'front' ? sh.foil.getContext('2d').getImageData(0, 0, SW / 4, SH / 4).data : null;
  const vig = side === 'front' ? renderer.readVignette() : null;
  const V = SL.vignette;
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
    const i = (y * SW + x) * 4;
    let r = 0.93 * p[i], gg = 0.925 * p[i + 1], b = 0.878 * p[i + 2];
    let ink = p[i + 3] / 255 + dyn[i] / 255;
    if (vig && x >= V.x && x < V.x + V.w && y >= V.y && y < V.y + V.h) {
      const vx = Math.floor((x - V.x) / V.w * vig.w), vy = vig.h - 1 - Math.floor((y - V.y) / V.h * vig.h);
      ink += vig.data[(vy * vig.w + vx) * 4] / 255;
    }
    ink = Math.min(1, ink);
    const red = dyn[i + 1] / 255, ovi = dyn[i + 2] / 255;
    r = r + (153 - r) * red; gg = gg + (41 - gg) * red; b = b + (33 - b) * red;
    r = r + (164 - r) * ovi; gg = gg + (125 - gg) * ovi; b = b + (31 - b) * ovi;
    r = r + (13 - r) * ink; gg = gg + (11 - gg) * ink; b = b + (21 - b) * ink;
    if (foil) { const f = foil[((y >> 2) * (SW / 4) + (x >> 2)) * 4] / 255; r += (170 - r) * f; gg += (175 - gg) * f; b += (185 - b) * f; }
    o[i] = r; o[i + 1] = gg; o[i + 2] = b; o[i + 3] = 255;
  }
  g.putImageData(out, 0, 0);
  return c.toDataURL('image/png');
};
$('#gl').addEventListener('wheel', e => {
  e.preventDefault();
  const step = e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0016);
  // with the loupe out, the wheel sets its power; hold Shift to move the view instead
  if (st.loupe && !e.shiftKey) {
    st.loupeZoom = Math.min(7, Math.max(1.8, st.loupeZoom * Math.exp(-step)));
    return;
  }
  zoomAt(e.clientX, e.clientY, Math.exp(-step));
}, { passive: false });
$('#fit').addEventListener('click', () => fitSheet());
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
document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(+b.dataset.mode)));
$('#loupe').addEventListener('click', () => setLoupe(!st.loupe));
$('#turn').addEventListener('click', flip);
$('#hold').addEventListener('click', () => {
  hold = !hold;
  if (!hold) wantShow = true;
  $('#hold').setAttribute('aria-pressed', String(hold));
  $('#hold').textContent = hold ? 'Resume printing' : 'Hold this proof';
});
$('#sound').addEventListener('click', () => {
  if (sound.on) sound.disable(); else sound.enable();
  $('#sound').setAttribute('aria-pressed', String(sound.on));
});
$('#root-switch').addEventListener('click', () => {
  rootName = rootName === 'ripple' ? 'xrplf' : 'ripple';
  const u = new URL(location.href); u.searchParams.set('root', rootName); history.replaceState(null, '', u);
  $('#root-switch').textContent = `Trust ${TRUST_ROOTS[rootName === 'ripple' ? 'xrplf' : 'ripple'].name} instead`;
  show = null; pulling = null; ledgers.clear(); newest = 0;
  target.ink[PART.STEPS] = 0;
  loadList();
});
$('#root-switch').textContent = `Trust ${TRUST_ROOTS[rootName === 'ripple' ? 'xrplf' : 'ripple'].name} instead`;

// ── an account, proven ──────────────────────────────────────────────────────
// The relay's reading is written in pencil at once. Then, for each ledger this
// page proves, the relay fetches the nodes from that ledger's state root down
// to the account's entry; the worker hashes every one of them up to the state
// root in the checked header. Only then is the balance inked, and the lantern.
let watch = null;        // { addr, key, told: { drops, ledger } | null, toldError }
const xrp = d => xrpText(d, '\u202F');   // grouped with narrow spaces, as on the sheet

function askProof(L) {
  if (!watch || !L.hdr || L.acctFor === watch.addr) return;
  if (show && L.seq < show.seq) return;            // already printed; never shown again
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
/** A result for the ledger on the press, after its turn has come: show it now. */
function late(L) { if (show && show.seq === L.seq && show.acctDone) paintAccount(L); }

function paintAccount(L) {
  const a = L.acct;
  if (!a || !watch) return;
  if (a.ok || a.absent) {
    watch.proven = { seq: L.seq, xrp: a.ok ? xrp(a.drops) : null, absent: !a.ok };
    dyn.account(watch.addr, a.ok ? a.drops : null, a.path.filter(Boolean));
    if (target.ink[PART.LANTERN] < 1) { target.ink[PART.LANTERN] = 1; dyn.stepTicks(7); sound.chime(); }
  } else {
    pencil(L);
  }
  note(L);
  if (tour) tour.event('account');
}

/** The relay's reading, in pencil, with what became of this ledger's proof. */
function pencil(L) {
  const a = L && L.acct, told = watch.told;
  const why = a && !a.ok && !a.absent
    ? `not proven for ledger ${fmt(L.seq)}: ${a.why}`
    : told ? `the relay’s reading, from ledger ${fmt(told.ledger)}; not yet proven here`
           : 'not yet proven here';
  dyn.pencil(watch.addr, told ? told.drops : null, why);
}

/** The words under the lookup box follow the proof of the ledger on the press. */
function note(L) {
  const told = watch.told, a = L && L.acct;
  const said = told ? `${xrp(told.drops)} XRP, the relay says.` : `The relay found no such account.`;
  let s, path = '';
  if (a && a.ok) {
    s = `${xrp(a.drops)} XRP in ledger ${fmt(L.seq)}, proven in this browser: the account’s entry hashes, ` +
        `through ${a.path.length - 1} inner nodes, up to the state root the validators signed. Its path from the root:`;
    path = [...a.path.slice(0, -1), 'entry'].join(' → ');
  } else if (a && a.absent) {
    const other = a.path[a.path.length - 1] === '';   // the path ended at someone else's entry
    s = `Ledger ${fmt(L.seq)} has no such account, proven in this browser: ` +
        (other ? 'the only entry where it would sit belongs to another account.' : 'the branch where it would sit is empty.') +
        ' Its path from the root:';
    path = a.path.filter(Boolean).join(' → ') + ' → nothing';
  } else if (a) {
    s = `${said} Not proven for ledger ${fmt(L.seq)}: ${a.why}. It stays in pencil.`;
  } else {
    s = `${said} Checking it against the next ledger this page proves…`;
  }
  $('#addr-note').textContent = s;
  $('#addr-path').textContent = path;
}

$('#addr-form').addEventListener('submit', async e => {
  e.preventDefault();
  const addr = $('#addr').value.trim();
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(addr)) { $('#addr-note').textContent = 'That is not an XRP Ledger address. They start with r.'; return; }
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
  watch = { addr, key, told: a.error ? null : { drops: a.balance, ledger: a.ledger }, toldError: a.error };
  for (const L of ledgers.values()) { L.acctFor = null; L.acct = null; }
  if (show) {
    show.acctDone = show.headerAt !== null;           // past the dome already: ink as soon as it checks
    target.ink[PART.LANTERN] = 0; dyn.clearAccount(); pencil();
  }
  note();
  for (const L of ledgers.values()) askProof(L);
  if (tour) tour.event('lookup');
});

addEventListener('keydown', e => {
  if (e.target instanceof Element && e.target.closest('input, textarea')) return;
  const k = e.key.toLowerCase();
  if (k >= '1' && k <= '4') setMode(+k - 1);
  else if (k === 'l') setLoupe(!st.loupe);
  else if (k === 't') flip();
  else if (k === 'h') $('#hold').click();
  else if (k === 'escape') setLoupe(false);
  else if (k === '+' || k === '=') zoomAt(innerWidth / 2, innerHeight * 0.42, 1.3);
  else if (k === '-' || k === '_') zoomAt(innerWidth / 2, innerHeight * 0.42, 1 / 1.3);
  else if (k === '0') fitSheet();
});
/** The stacked layout keeps the footer clear of the menu, whatever it wraps to. */
function measureNav() {
  document.documentElement.style.setProperty('--nav-h', `${Math.ceil($('nav.ui').getBoundingClientRect().height)}px`);
}
addEventListener('resize', measureNav);
setMode(0);
measureNav();
boot();
