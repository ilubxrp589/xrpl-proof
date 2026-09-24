/* The Deep Field receipt: "Lookback". A deep field is a look back in time,
 * and so is a receipt: from the ledger the validators signed just now, back
 * to the one the transaction landed in. It is drawn in Deep Field's own terms
 * (its gate, its event horizon, its validator flares, its transaction hues,
 * its palette and faces), and every mark is a proven fact, shown once:
 *   the gate       one flare per listed validator, lit if it signed the ledger
 *                  signed now; as in Deep Field, the horizon inside it is open
 *                  only because they reached a quorum
 *   the body       the transaction, in its type's hue, deep in the horizon's
 *                  well: the further back its ledger, the smaller it is. If it
 *                  failed it is unlit, since only its fee took effect
 *   the facts      what moved, between whom, how it ended, when; if it
 *                  failed, its figures are unlit too, since nothing moved
 *   the lookback   how long ago, and the proof's chain node by node: the
 *                  transaction's ledger, any record ledger, the ledger signed
 *                  now, and how each one reaches the next
 *   the identifiers  hashes and fields, whole
 * The sky is the transaction's own, drawn from its hash. The canvas comes back
 * with .layer, every word drawn and where, so the PDF can lay the same words
 * under the picture as real text: invisible, but selectable and searchable. */
import { rng, hexBytes } from './engrave.js';
import { amountText, headline, utc } from './receipt-art.js';

export const RW = 1654, RH = 2339;
const GROUND = '#01030A', BONE = '#EEF1F8', BONE2 = '#BECBDF', LBL = '#7C8AA4', HAIR = 'rgba(124,138,164,0.28)';
const HORIZON = '#7FE0FF', CORAL = '#FF6A55';
const DISPLAY = "'Newsreader', Georgia, serif", MONO = "'Geist Mono', ui-monospace, monospace";
// Deep Field's transaction hues (flow/10-space.html TXTYPES), so a body is the same colour in both
// places; a type Deep Field has no body for is grey there, and here
const HUES = { Payment: [0.31, 0.76, 0.97], OfferCreate: [0.89, 0.45, 0.37], OfferCancel: [0.97, 0.64, 0.30],
  TrustSet: [0.88, 0.80, 0.44], AMMDeposit: [0.50, 0.68, 0.24], AMMWithdraw: [0.48, 0.84, 0.57], NFTokenMint: [0.00, 0.91, 0.78],
  NFTokenCreateOffer: [0.41, 0.68, 0.61], EscrowCreate: [0.00, 0.85, 0.90], EscrowFinish: [0.72, 0.91, 1.00],
  AccountSet: [0.62, 0.57, 1.00], CheckCreate: [0.71, 0.69, 0.94], SetRegularKey: [1.00, 0.62, 0.92], TicketCreate: [0.97, 0.51, 0.60] };
const OTHER = [0.60, 0.64, 0.71];
const css = (c, a = 1) => `rgba(${c.map(x => Math.round(Math.min(1, x) * 255)).join(',')},${a})`;
const group = x => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
// Deep Field's light, as its composite pass handles it: added up in HDR, then ACES filmic to display
const aces = x => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Deep Field's faces must be in before drawing. */
export async function spaceFonts() {
  await Promise.all(['300 80px Newsreader', '400 80px Newsreader', '300 20px "Geist Mono"', '400 20px "Geist Mono"', '500 20px "Geist Mono"']
    .map(f => document.fonts.load(f)));
}

/** How long ago, from two close times, in the largest units that read well. */
export function lookback(seconds) {
  const s = Math.max(0, Math.round(seconds)), d = Math.floor(s / 86400), y = Math.floor(d / 365.25);
  if (y >= 1) { const rd = Math.floor(d - y * 365.25); return `${y} year${y > 1 ? 's' : ''}${rd ? `, ${rd} day${rd > 1 ? 's' : ''}` : ''}`; }
  if (d >= 1) { const h = Math.floor((s - d * 86400) / 3600); return `${d} day${d > 1 ? 's' : ''}${h ? `, ${h} hour${h > 1 ? 's' : ''}` : ''}`; }
  if (s >= 3600) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return `${h} hour${h > 1 ? 's' : ''}${m ? `, ${m} min` : ''}`; }
  if (s >= 60) return `${Math.floor(s / 60)} min, ${s % 60} s`;
  return `${s} seconds`;
}

// a light drawn pixel by pixel into its own canvas, to be added onto the sheet
function light(rad, fn) {
  const n = Math.ceil(rad) * 2 + 2, h = n / 2, cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const cx = cv.getContext('2d'), im = cx.createImageData(n, n), px = im.data;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = (x + 0.5 - h) / rad, dy = (y + 0.5 - h) / rad, d2 = dx * dx + dy * dy;
    if (d2 > 1) continue;
    const c = fn(Math.sqrt(d2), d2, Math.atan2(dy, dx)), o = (y * n + x) * 4;
    px[o] = 255 * aces(c[0]); px[o + 1] = 255 * aces(c[1]); px[o + 2] = 255 * aces(c[2]); px[o + 3] = 255;
  }
  cx.putImageData(im, 0, 0);
  return cv;
}
// Deep Field's node flare (its sprite shader): a hot core and a thin annulus, the annulus
// fainter here, since on paper the flare is drawn many times larger than on screen
const flare = col => (d, d2) => { const a = Math.exp(-24 * d2) * 1.55 + Math.exp(-420 * (d - 0.62) ** 2) * 0.24 + (1 - d) ** 7 * 0.3; return col.map(k => k * a); };
const glow = col => (d, d2) => { const a = Math.exp(-4.2 * d2) + 0.22 * (1 - d) ** 3; return col.map(k => k * a); };

export function drawSpaceReceipt(v) {
  const c = document.createElement('canvas'); c.width = RW; c.height = RH;
  const sheet = c.getContext('2d'), scratch = document.createElement('canvas').getContext('2d');
  let g = sheet;                                        // a measuring pass draws on scratch instead
  const tx = v.tx, r = rng(hexBytes(v.hash)), ok = tx.succeeded, body = HUES[tx.type] || OTHER;
  const layer = [];
  const font = (size, weight = 400, fam = MONO) => { g.font = `${weight} ${size}px ${fam}`; };
  const say = (s, x, y, size, { weight = 400, fam = MONO, fill = BONE, align = 'left', track = 0 } = {}) => {
    font(size, weight, fam); g.fillStyle = fill; g.textAlign = align; g.textBaseline = 'alphabetic';
    if ('letterSpacing' in g) g.letterSpacing = `${track}em`;
    g.fillText(s, x, y);
    const w = g.measureText(s).width;
    if ('letterSpacing' in g) g.letterSpacing = '0em';
    layer.push({ s, x: align === 'left' ? x : align === 'right' ? x - w : x - w / 2, y, w, size });
    return w;
  };
  const L = 150, Rt = RW - 150, back = v.anchor.seq - v.ledger.seq;

  // ── everything under the gate, as a function of where it starts: run once to measure, once to draw
  const lower = y0 => {
    const h = headline(tx);
    let y = y0;
    say(tx.type, L, y, 24, { fill: css(body), track: 0.06 });
    y += 132;
    font(128, 300, DISPLAY);
    const big = h.amount ? amountText(h.amount) : tx.type;
    let size = 128;
    while (size > 60 && g.measureText(big).width > Rt - L) font(--size, 300, DISPLAY);
    // a failed transaction's figures are unlit, like its body: they were asked for, and did not move
    const unlit = 'rgba(190,203,223,0.4)';
    say(big, L, y, size, { weight: 300, fam: DISPLAY, fill: ok ? BONE : unlit });
    const i1 = h.amount && h.amount.issuer, i2 = h.then && tx.takerPays && tx.takerPays.issuer, both = i1 && i1 === i2;
    if (i1 && !both) { y += 44; say(`issued by ${i1}`, L, y, 21, { fill: LBL }); }
    if (h.then) {
      y += 52; say(h.then, L, y, 32, { weight: 300, fam: DISPLAY, fill: ok ? BONE2 : unlit });
      if (i2) { y += 40; say(`${both ? 'both ' : ''}issued by ${i2}`, L, y, 21, { fill: LBL }); }
    }
    y += 74;
    const party = (word, who) => { say(word, L, y, 22, { fill: LBL, track: 0.1 }); say(who, L + 90, y, 27, { fill: BONE2 }); y += 46; };
    party('from', tx.account);
    if (tx.destination) party('to', tx.destination);
    y += 20;
    const w = say(ok ? 'Succeeded' : `Failed: ${tx.result}, fee charged`, L, y, 25, { weight: 500, fill: ok ? HORIZON : CORAL });
    say(`closed ${utc(v.ledger.close)}`, L + w + 26, y, 23, { fill: LBL });

    // the lookback: how long ago, from the two signed close times, and the proof's chain
    y += 106;
    g.fillStyle = HAIR; g.fillRect(L, y - 66, Rt - L, 1.2);
    say('LOOKBACK', L, y, 19, { fill: LBL, track: 0.22 });
    say(back ? lookback(v.anchor.close - v.ledger.close) : 'none', L + 190, y + 6, 46, { weight: 300, fam: DISPLAY });
    // the nodes: the transaction's ledger, the record ledger that names it (when it is far
    // back), the ledger signed now; each link says how one reaches the next
    const nodes = [{ seq: v.ledger.seq, role: back ? 'the transaction’s ledger' : 'the transaction’s ledger, signed now', col: css(body) }];
    const flag = v.steps > 1 ? v.ledger.seq + v.steps - 1 : null;
    if (flag) nodes.push({ seq: flag, role: 'the next 256th ledger', col: BONE2 });
    if (back) nodes.push({ seq: v.anchor.seq, role: 'signed now', col: HORIZON });
    const links = [];
    if (flag) links.push({ text: `${v.steps - 1} parent hash${v.steps - 1 > 1 ? 'es' : ''}`, ticks: v.steps - 1 });
    if (back) links.push({ text: v.record === 'flags' ? 'its record of every 256th ledger' : 'its record of the last 256 ledgers', ticks: 0 });
    const ly = y + 120, x0 = L + 24, x1 = Rt - 24, gap = nodes.length > 1 ? (x1 - x0) / (nodes.length - 1) : 0;
    // the line runs from the transaction's hue to the horizon's: its light, arriving now
    const beam = g.createLinearGradient(x0, 0, x1, 0);
    beam.addColorStop(0, css(body, 0.7)); beam.addColorStop(1, 'rgba(127,224,255,0.7)');
    links.forEach((lk, i) => {
      const a = x0 + i * gap + 22, b = x0 + (i + 1) * gap - 22;
      g.strokeStyle = beam; g.lineWidth = 1.3; g.beginPath(); g.moveTo(a, ly); g.lineTo(b, ly); g.stroke();
      if (lk.ticks) {                                    // one tick per parent hash walked
        g.lineWidth = 1; g.beginPath();
        for (let k = 1; k <= lk.ticks; k++) { const x = a + (b - a) * k / (lk.ticks + 1); g.moveTo(x, ly - 6); g.lineTo(x, ly + 6); }
        g.stroke();
      }
      say(lk.text, (a + b) / 2, ly - 22, 19, { fill: LBL, align: 'center' });
    });
    nodes.forEach((nd, i) => {
      const x = x0 + i * gap, al = nodes.length === 1 || i === 0 ? 'left' : i === nodes.length - 1 ? 'right' : 'center';
      const tx0 = al === 'left' ? x - 14 : al === 'right' ? x + 14 : x;
      g.fillStyle = GROUND; g.beginPath(); g.arc(x, ly, 13, 0, Math.PI * 2); g.fill();
      g.strokeStyle = nd.col; g.lineWidth = 2; g.beginPath(); g.arc(x, ly, 13, 0, Math.PI * 2); g.stroke();
      g.fillStyle = nd.col; g.beginPath(); g.arc(x, ly, 5, 0, Math.PI * 2); g.fill();
      say(group(nd.seq), tx0, ly + 56, 29, { weight: 500, align: al });
      say(nd.role, tx0, ly + 90, 20, { fill: LBL, align: al });
    });

    // the identifiers
    y = ly + 180;
    g.fillStyle = HAIR; g.fillRect(L, y - 44, Rt - L, 1.2);
    const rows = [['transaction', v.hash], ['ledger hash', v.ledger.hash], ['fee', amountText(tx.fee)],
                  ['sequence', tx.sequence ? group(tx.sequence) : 'a ticket']];
    if (tx.destinationTag !== null) rows.push(['destination tag', String(tx.destinationTag)]);
    if (tx.sourceTag !== null) rows.push(['source tag', String(tx.sourceTag)]);
    if (tx.invoiceId) rows.push(['invoice', tx.invoiceId]);
    if (tx.delivered && tx.amount && amountText(tx.delivered) !== amountText(tx.amount)) rows.push(['amount sent', amountText(tx.amount)]);
    for (const m of tx.memos.slice(0, 3)) rows.push([m.type && m.type.length < 20 ? `memo (${m.type})` : 'memo', m.data || '']);
    const V = L + 250;
    rows.forEach(([k, val], i) => {
      if (i) y += 42;
      say(k, L, y, 19, { fill: LBL, track: 0.06 });
      let s = 22;
      for (font(s); s > 13 && g.measureText(val).width > Rt - V; ) font(--s);
      let text = val;
      while (g.measureText(text).width > Rt - V && text.length > 4) text = text.slice(0, -2) + '…';
      say(text, V, y, s, { fill: BONE2 });
    });
    return y;                                            // the last line's baseline
  };
  g = scratch;
  const depth = lower(0);
  // the details keep their place when they fit; with many (memos, tags) they rise, and the gate shrinks
  const y0 = Math.min(1210, RH - 205 - depth);
  const R = Math.max(250, Math.min(384, (y0 - 458) / 2)), ax = RW / 2, ay = 262 + R, s = R / 235;   // s: Deep Field units to px
  const words = () => {
    say(`${v.anchor.signers} of ${v.anchor.listed} validators signed · quorum ${v.anchor.quorum}`, ax, ay + R + 76, 22, { fill: BONE2, align: 'center' });
    say(`on the list published by ${v.publisher}`, ax, ay + R + 108, 19, { fill: LBL, align: 'center' });
    say('Receipt', L, 196, 76, { weight: 300, fam: DISPLAY });
    say('XRP LEDGER', Rt, 186, 19, { fill: LBL, align: 'right', track: 0.22 });
    lower(y0);
    say('Check it: drop this file on v2v.halcyon-names.io/proof. The evidence is attached; the check needs nothing else.', L, RH - 150, 19, { fill: LBL });
    say('Proof of a transaction. Not currency, no monetary value.', L, RH - 118, 17, { fill: 'rgba(124,138,164,0.7)' });
  };
  // where the words will go, so that no star lands on a character: a dot by a hash is a misreading
  layer.length = 0; words();
  const clear = layer.map(t => [t.x - 8, t.y - t.size, t.x + t.w + 8, t.y + t.size * 0.35]);
  const free = (x, y, m = 0) => !clear.some(([a, b, c2, d]) => x > a - m && x < c2 + m && y > b - m && y < d + m);
  layer.length = 0; g = sheet;

  // ── the ground: deep space, a faint nebula, the distant shell of stars
  g.fillStyle = GROUND; g.fillRect(0, 0, RW, RH);
  g.globalCompositeOperation = 'lighter';
  for (const [rgb, a, rad] of [['127,224,255', 0.05, 900], ['140,120,255', 0.035, 760], ['255,106,85', 0.022, 620]]) {
    const x = RW * (0.2 + r() * 0.6), y = RH * (0.15 + r() * 0.5), n = g.createRadialGradient(x, y, 0, x, y, rad);
    n.addColorStop(0, `rgba(${rgb},${a})`); n.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = n; g.fillRect(0, 0, RW, RH);
  }
  const star = (x, y, m, blue) => {                     // m: brightness 0..1
    g.fillStyle = `rgba(${blue ? '190,215,255' : '238,241,248'},${0.25 + 0.75 * m})`;
    g.beginPath(); g.arc(x, y, 0.5 + 1.5 * m * m, 0, Math.PI * 2); g.fill();
    if (m > 0.93) { g.strokeStyle = `rgba(238,241,248,${0.35 * m})`; g.lineWidth = 0.8;
      g.beginPath(); g.moveTo(x - 7, y); g.lineTo(x + 7, y); g.moveTo(x, y - 7); g.lineTo(x, y + 7); g.stroke(); }
  };
  // (every star and galaxy takes the same draws from the hash whether it is shown or not, so
  // the sky, and the horizon's phase after it, belong to the transaction alone)
  for (let i = 0; i < 1300; i++) { const x = r() * RW, y = r() * RH, m = r() ** 5, blue = r() < 0.3; if (free(x, y, m > 0.93 ? 9 : 3)) star(x, y, m, blue); }
  // faint galaxies round the gate, clear of it and of the words
  for (let i = 0, placed = 0; i < 40; i++) {
    const x = 60 + r() * (RW - 120), y = 230 + r() * (2 * R + 60), sz = 8 + r() * 26, e = 0.2 + r() * 0.6, rot = r() * Math.PI, warm = r() < 0.5;
    if (placed >= 12 || Math.hypot(x - ax, y - ay) < R * 1.22 || !free(x, y, sz)) continue;
    placed++;
    g.save(); g.translate(x, y); g.rotate(rot); g.scale(1, e);
    const gg = g.createRadialGradient(0, 0, 0, 0, 0, sz);
    gg.addColorStop(0, `rgba(${warm ? '255,236,210' : '200,220,255'},0.42)`); gg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gg; g.beginPath(); g.arc(0, 0, sz, 0, Math.PI * 2); g.fill(); g.restore();
  }

  // ── the gate. Inside it, the event horizon: Deep Field's log-spiral well, open because a
  // quorum signed, its phase set by the transaction's hash
  const Rh = (235 - 26) * s, T = r() * 1000;
  g.drawImage(light(Rh, (d, d2, a) => {
    const lr = Math.log(Math.max(d, 0.018));
    const r1 = Math.sin(lr * 7.0 - T * 1.35 + a * 2) * 0.5 + 0.5;
    const r2 = Math.sin(lr * 13.0 - T * 2.10 - a) * 0.5 + 0.5;
    const r3 = Math.sin(lr * 3.4 - T * 0.80 + a) * 0.5 + 0.5;
    const k = (r1 * 0.46 + r2 * 0.24 + r3 * 0.30) ** 1.7 * sstep(1, 0.42, d) * sstep(0, 0.14, d) * 1.9;
    return [0.075 * k, 0.180 * k, 0.290 * k];
  }), ax - Math.ceil(Rh) - 1, ay - Math.ceil(Rh) - 1);
  // the transaction, deep in the well: nearer is larger. A failed one is unlit, its hue a rim only
  const far = Math.min(1, Math.log10(1 + back) / 8), rb = (30 - 21 * far) * s / 1.634;
  if (ok) {
    const bloom = g.createRadialGradient(ax, ay, 0, ax, ay, rb * 6);
    bloom.addColorStop(0, css(body, 0.5)); bloom.addColorStop(0.3, css(body, 0.12)); bloom.addColorStop(1, css(body, 0));
    g.fillStyle = bloom; g.fillRect(ax - rb * 6, ay - rb * 6, rb * 12, rb * 12);
  }
  g.globalCompositeOperation = 'source-over';
  if (ok) {
    const sph = g.createRadialGradient(ax - rb * 0.35, ay - rb * 0.35, 0, ax, ay, rb * 1.05);
    sph.addColorStop(0, css(body.map(k => k + (1 - k) * 0.7))); sph.addColorStop(0.5, css(body)); sph.addColorStop(1, css(body.map(k => k * 0.35)));
    g.fillStyle = sph;
  } else g.fillStyle = '#060A14';
  g.beginPath(); g.arc(ax, ay, rb, 0, Math.PI * 2); g.fill();
  if (!ok) { g.strokeStyle = css(body, 0.9); g.lineWidth = 1.6; g.stroke(); }
  // the ring: its body, the stepped inner lip, and the thin outer ring
  g.fillStyle = 'rgba(20,38,60,0.55)'; g.beginPath(); g.arc(ax, ay, R + 11 * s, 0, Math.PI * 2); g.arc(ax, ay, R - 11 * s, 0, Math.PI * 2, true); g.fill();
  for (const [rr, col, lw] of [[R + 11 * s, 'rgba(190,203,223,0.22)', 1.2], [R - 11 * s, 'rgba(127,224,255,0.30)', 1.2],
                               [R - 18 * s, 'rgba(127,224,255,0.14)', 1], [R * 1.075, 'rgba(127,190,255,0.13)', 1]]) {
    g.strokeStyle = col; g.lineWidth = lw; g.beginPath(); g.arc(ax, ay, rr, 0, Math.PI * 2); g.stroke();
  }
  // one flare per listed validator, where Deep Field puts it; lit if it signed. Each is sized
  // from its own key, so a validator looks the same on every receipt
  const signed = new Set(v.anchor.signed), n = v.masters.length, sprites = new Map();
  const sprite = (key, rad, fn) => sprites.get(key) || sprites.set(key, light(rad, fn)).get(key);
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2, x = ax + Math.cos(a) * R, y = ay + Math.sin(a) * R;
    const vary = 0.82 + 0.36 * (hexBytes(v.masters[i])[1] % 5) / 4, lit = signed.has(i);
    if (lit) {
      const gl = sprite(`g${vary}`, 48 * s * vary, glow([0.55 * 0.115, 1.10 * 0.115, 1.70 * 0.115]));
      const fl = sprite(`f${vary}`, 11 * s * vary, flare([0.54, 0.88, 1.22]));
      g.drawImage(gl, x - gl.width / 2, y - gl.height / 2); g.drawImage(fl, x - fl.width / 2, y - fl.height / 2);
    } else {                                             // listed, but no signature: an empty socket
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = GROUND; g.strokeStyle = 'rgba(124,138,164,0.6)'; g.lineWidth = 1.3;
      g.beginPath(); g.arc(x, y, 4.5 * s, 0, Math.PI * 2); g.fill(); g.stroke();
      g.globalCompositeOperation = 'lighter';
    }
  }
  g.globalCompositeOperation = 'source-over';

  // ── the words
  words();
  c.layer = layer;
  return c;
}
