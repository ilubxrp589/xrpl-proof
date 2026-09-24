/* The printed layers of the proof, drawn with canvas 2D and handed to the
 * shader as textures. Nothing here is decoration: each element is fed by, and
 * reports, one of the checks in verify.js.
 *
 * The sheet is a certificate, 3 : 2, deliberately NOT a banknote: no
 * denomination, no currency wording, and a legend saying so in the border.
 *
 *   underprint   guilloché in two lithographic inks that fade one into the
 *                other across the sheet. The rosette has 35 petals, one per
 *                validator, each petal's swing set by that validator's key.
 *   intaglio     frame, lettering and microprint: raised ink the shader
 *                lights as relief. The microprint IS the data (the trusted
 *                key, ledger hash, state root), readable under the loupe.
 *   autographs   one small signature per validator, drawn from the bytes of
 *                the signature it actually put on this ledger, and only once
 *                that signature has been checked.
 *   ledger block the ledger's number, hash and state root, inked when the
 *                header hashes to what the validators signed.
 *   watermark    the trusted key's medallion, in the paper; it shows only in
 *                transmitted light. The one thing this proof trusts is not
 *                printed on it. It is in the sheet.
 *   UV print     each validator's domain, fluorescing only once its
 *                signature on this ledger has been checked.
 *   quorum seal  a round foil seal; the shader strikes its star once 28 of
 *                the listed validators have signed the same ledger.
 */
export const W = 3600, H = 2400;

// Layout, in sheet pixels.
export const L = {
  vignette: { x: 1062, y: 630, w: 1476, h: 1015 },    // the temple (the engraving target's 1600:1100)
  sig:      { x: 1000, y: 1735, w: 1600, h: 320 },    // 35 autographs, 2 rows
  count:    { cx: 610, cy: 1010, r: 276 },            // validator rosette + count
  ledger:   { x: 262, y: 1770 },                      // the ledger block
  water:    { cx: 3055, cy: 990, rx: 240, ry: 340 },  // watermark window
  thread:   { x: 2702, w: 22 },                       // security thread
  seal:     { cx: 3055, cy: 1810, r: 180 },           // quorum foil seal
  serial:   { x: 262, y: 520 },                       // red letterpress
  // clearances every element respects
  frameIn: 232, micro: 246, microEnd: 300,            // inner rule, microprint line, where it stops
};

/** Shorten a string with an ellipsis until it fits `max` pixels in the current font. */
export function fit(ctx, s, max) {
  if (ctx.measureText(s).width <= max) return s;
  while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s + '…';
}

export const INK = '#221B30', TEAL = '#3E7D78', ROSE = '#B97C78';
const FONT = "'Bodoni Moda', 'Bodoni 72', 'Didot', serif";
export const fontSpec = (size, weight = 500, italic = false) =>
  `${italic ? 'italic ' : ''}${weight} ${size}px ${FONT}`;

export function canvas(w = W, h = H) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
/** Deterministic PRNG from bytes. */
export function rng(bytes) {
  let s = 0x9E3779B9 >>> 0;
  for (let i = 0; i < bytes.length; i++) s = Math.imul(s ^ bytes[i], 0x85EBCA6B) >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
export const hexBytes = h => Uint8Array.from((h.match(/../g) || []).map(x => parseInt(x, 16)));

// ── guilloché ────────────────────────────────────────────────────────────────
/** A woven ring: K closed curves r(θ) = R + a·sin(nθ + φk) + b·sin(mθ − 2φk). */
export function rosette(ctx, cx, cy, R, a, b, n, m, K, lw, style, phase = 0) {
  ctx.lineWidth = lw; ctx.strokeStyle = style;
  const steps = Math.max(720, n * 36);
  for (let k = 0; k < K; k++) {
    const ph = phase + (k / K) * (Math.PI * 2 / n);
    ctx.beginPath();
    for (let s = 0; s <= steps; s++) {
      const t = (s / steps) * Math.PI * 2;
      const r = R + a * Math.sin(n * t + ph) + b * Math.sin(m * t - 2 * ph);
      const x = cx + Math.cos(t) * r, y = cy + Math.sin(t) * r;
      s ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath(); ctx.stroke();
  }
}
/** A braided band following a rectangle: K strands offset by phased sines. */
export function braid(ctx, x, y, w, h, amp, wavelength, K, lw, style) {
  const per = 2 * (w + h), N = Math.ceil(per / 3);
  const at = s => {
    s = ((s % per) + per) % per;
    if (s < w) return [x + s, y, 0, -1];
    if (s < w + h) return [x + w, y + (s - w), 1, 0];
    if (s < 2 * w + h) return [x + w - (s - w - h), y + h, 0, 1];
    return [x, y + h - (s - 2 * w - h), -1, 0];
  };
  const turns = Math.round(per / wavelength);
  ctx.lineWidth = lw; ctx.strokeStyle = style;
  for (let k = 0; k < K; k++) {
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const s = (i / N) * per, [px, py, nx, ny] = at(s);
      const o = amp * Math.sin((s / per) * turns * Math.PI * 2 + (k / K) * Math.PI * 2);
      i ? ctx.lineTo(px + nx * o, py + ny * o) : ctx.moveTo(px + nx * o, py + ny * o);
    }
    ctx.closePath(); ctx.stroke();
  }
}

// ── lettering ────────────────────────────────────────────────────────────────
export function text(ctx, s, x, y, size, { weight = 500, italic = false, align = 'left', track = 0, fill = '#fff', stroke = 0 } = {}) {
  ctx.font = fontSpec(size, weight, italic);
  ctx.textAlign = align; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = fill;
  if (stroke) { ctx.lineWidth = stroke; ctx.strokeStyle = fill; ctx.lineJoin = 'round'; }
  if (!track) { ctx.fillText(s, x, y); if (stroke) ctx.strokeText(s, x, y); return ctx.measureText(s).width; }
  const widths = [...s].map(ch => ctx.measureText(ch).width + track);
  const total = widths.reduce((a, b) => a + b, 0) - track;
  let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  ctx.textAlign = 'left';
  [...s].forEach((ch, i) => { ctx.fillText(ch, cx, y); if (stroke) ctx.strokeText(ch, cx, y); cx += widths[i]; });
  return total;
}
/** Letters filled with engraved rules instead of flat ink, with an outline. */
function ruledText(ctx, s, x, y, size, opts = {}) {
  const c = canvas(Math.ceil(size * s.length * 0.8 + 80), Math.ceil(size * 1.35));
  const g = c.getContext('2d');
  const w = text(g, s, 40, size, size, { ...opts, align: 'left' });
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = '#fff';
  const pitch = Math.max(3, size / 24);
  for (let yy = 0; yy < c.height; yy += pitch) g.fillRect(0, yy, c.width, pitch * 0.5);
  g.globalCompositeOperation = 'source-over';
  g.lineWidth = Math.max(1.4, size / 80); g.strokeStyle = '#fff';
  g.font = fontSpec(size, opts.weight || 500, opts.italic);
  g.textBaseline = 'alphabetic';
  g.strokeText(s, 40, size);
  const dx = opts.align === 'center' ? x - w / 2 - 40 : opts.align === 'right' ? x - w - 40 : x - 40;
  ctx.drawImage(c, dx, y - size);
}
/** Text repeated along a straight run until it fills `len`. Microprint. */
export function micro(ctx, s, x, y, len, size, angle = 0) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(angle);
  ctx.beginPath(); ctx.rect(0, -size, len, size * 2); ctx.clip();
  ctx.font = fontSpec(size, 600); ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const unit = s + '   ', uw = ctx.measureText(unit).width;
  ctx.lineWidth = 0.5; ctx.strokeStyle = '#fff';
  for (let p = 0; p < len; p += uw) { ctx.fillText(unit, p, 0); ctx.strokeText(unit, p, 0); }
  ctx.restore();
}
/** Text set along an arc, centred on angle a0 (radians, 0 = right, CW). */
function arcText(ctx, s, cx, cy, r, a0, size, opts = {}) {
  ctx.save();
  ctx.font = fontSpec(size, opts.weight || 600, opts.italic);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const track = opts.track || 0;
  const widths = [...s].map(ch => ctx.measureText(ch).width + track);
  const total = widths.reduce((a, b) => a + b, 0);
  let a = a0 - total / r / 2 * (opts.inside ? -1 : 1);
  [...s].forEach((ch, i) => {
    const da = widths[i] / r * (opts.inside ? -1 : 1);
    a += da / 2;
    ctx.save();
    ctx.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.rotate(a + (opts.inside ? -Math.PI / 2 : Math.PI / 2));
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    a += da / 2;
  });
  ctx.restore();
}

// ── generative marks ─────────────────────────────────────────────────────────
/** A pen signature from signature bytes: a stroke with loops whose rhythm,
 *  slant and pressure are all read from the bytes. */
export function autograph(ctx, x, y, w, h, bytes) {
  const r = rng(bytes);
  const loops = 3 + Math.floor(r() * 4), slant = (r() - 0.5) * 0.6;
  const f = [1 + r() * 2.5, 2 + r() * 4, 5 + r() * 7], p = [r() * 6.28, r() * 6.28, r() * 6.28];
  const amp = [0.26 + r() * 0.1, 0.1 + r() * 0.1, 0.04 + r() * 0.05];
  const N = 320;
  let prev = null;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const lx = t * w * 0.84 + w * 0.08 + Math.sin(t * Math.PI * 2 * loops + p[0]) * w * 0.04;
    const ly = h * 0.5 - h * (amp[0] * Math.sin(t * Math.PI * 2 * f[0] + p[0]) +
      amp[1] * Math.sin(t * Math.PI * 2 * f[1] + p[1]) + amp[2] * Math.sin(t * Math.PI * 2 * f[2] + p[2]));
    const px = x + lx + (h * 0.5 - ly) * slant * 0.35, py = y + ly;
    const pressure = 0.3 + 0.7 * Math.abs(Math.sin(t * Math.PI * (2 + f[0]) + p[2]));
    if (prev) {
      ctx.lineWidth = 0.9 + pressure * Math.max(1.6, h * 0.03);
      ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(px, py); ctx.stroke();
    }
    prev = [px, py];
  }
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(x + w * 0.1, y + h * 0.9);
  ctx.bezierCurveTo(x + w * (0.3 + r() * 0.2), y + h * (0.72 + r() * 0.3), x + w * 0.7, y + h * 1.0, x + w * 0.93, y + h * 0.82);
  ctx.stroke();
}

/** The trusted key's medallion: layered rosettes whose radii and lobes are
 *  read from the key bytes. Drawn as paper density for the watermark. */
function medallion(ctx, cx, cy, rx, ry, keyBytes, lw = 3.2) {
  const r = rng(keyBytes);
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(rx / ry, 1);
  const R = ry * 0.82;
  for (let l = 0; l < 7; l++) {
    const n = 5 + Math.floor(r() * 9), m = 9 + Math.floor(r() * 21);
    const a = R * (0.05 + r() * 0.1), b = R * (0.02 + r() * 0.06), base = R * (0.35 + 0.6 * (l / 7));
    ctx.globalAlpha = 0.24 + 0.1 * r();
    rosette(ctx, 0, 0, base, a, b, n, m, 14, lw, '#fff', r() * 6.28);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

const short = (h, a = 8, b = 6) => h.slice(0, a) + '…' + h.slice(-b);
/** Drops as XRP, exactly (no floating point), grouped with `sep`: thin spaces
 *  on the sheet, where Bodoni's comma reads as a full stop. */
export function xrpText(drops, sep = '\u2009') {
  const d = BigInt(drops), neg = d < 0n, a = neg ? -d : d;
  const whole = (a / 1000000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const frac = (a % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}

/** A double rule round the sheet that stops short of four corner medallions,
 *  so no line runs through an ornament. */
function frame(g, heavy, light) {
  const a = 210, b = 232, gap = 58, mid = (a + b) / 2;
  const rule = (inset, lw) => {
    g.lineWidth = lw;
    const x0 = inset, x1 = W - inset, y0 = inset, y1 = H - inset;
    g.beginPath();
    g.moveTo(x0 + gap, y0); g.lineTo(x1 - gap, y0);
    g.moveTo(x0 + gap, y1); g.lineTo(x1 - gap, y1);
    g.moveTo(x0, y0 + gap); g.lineTo(x0, y1 - gap);
    g.moveTo(x1, y0 + gap); g.lineTo(x1, y1 - gap);
    g.stroke();
  };
  rule(a, heavy); rule(b, light);
  for (const [cx, cy] of [[mid, mid], [W - mid, mid], [mid, H - mid], [W - mid, H - mid]]) {
    g.lineWidth = 2.4;
    g.beginPath(); g.arc(cx, cy, 44, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, 38, 0, Math.PI * 2); g.stroke();
    rosette(g, cx, cy, 20, 6, 2, 8, 16, 3, 1.1, '#fff');
  }
}
const domainOf = v => v.domain || (v.manifest && v.manifest.domain) || short(v.master, 6, 4);

// ── the static sheet ─────────────────────────────────────────────────────────
/** Build the static layers once fonts are loaded:
 *  plate  RGB underprint on white, A intaglio ink (packed)
 *  foil   R foil mask (quarter size)
 *  uv     RGB fluorescent fibres (half size)
 *  water  R watermark density (quarter size)
 *  back   RGB back underprint, A back ink (packed) */
export function buildStatic({ trustRoot, trustName, validators, quorum }) {
  const V = L.vignette, n = validators.length;
  const fountain = ctx => {
    const f = ctx.createLinearGradient(0, 0, W, 0);
    f.addColorStop(0, TEAL); f.addColorStop(0.5, '#708F8B'); f.addColorStop(1, ROSE);
    return f;
  };
  // ── underprint
  const under = canvas(), u = under.getContext('2d');
  u.fillStyle = '#fff'; u.fillRect(0, 0, W, H);
  u.globalAlpha = 0.45; u.strokeStyle = fountain(u); u.lineWidth = 1.1;
  for (let y = 60; y < H - 50; y += 10) {
    u.beginPath();
    for (let x = 50; x <= W - 50; x += 12) {
      const yy = y + 3.4 * Math.sin(x / 63 + y / 41) + 1.7 * Math.sin(x / 19 - y / 27);
      x > 50 ? u.lineTo(x, yy) : u.moveTo(x, yy);
    }
    u.stroke();
  }
  u.globalAlpha = 1;
  braid(u, 90, 90, W - 180, H - 180, 30, 46, 9, 1.35, fountain(u));
  braid(u, 138, 138, W - 276, H - 276, 13, 32, 5, 1.0, fountain(u));
  // the validator rosette: 35 petals, each swung by its validator's key
  const C = L.count;
  validators.forEach((v, i) => {
    const kr = rng(hexBytes(v.master));
    const a0 = (i / n) * Math.PI * 2 - Math.PI / 2;
    u.strokeStyle = i % 2 ? TEAL : '#4F8A84'; u.lineWidth = 1.25;
    for (let k = 0; k < 6; k++) {
      u.beginPath();
      for (let s = 0; s <= 90; s++) {
        const t = s / 90, ang = a0 + (t - 0.5) * (Math.PI * 2 / n) * (2.2 + kr() * 0.6);
        const rr = C.r * 0.42 + C.r * 0.58 * Math.sin(Math.PI * t) ** (0.8 + k * 0.08) + 7 * Math.sin(t * 22 + k);
        const x = C.cx + Math.cos(ang) * rr, y = C.cy + Math.sin(ang) * rr;
        s ? u.lineTo(x, y) : u.moveTo(x, y);
      }
      u.stroke();
    }
  });
  rosette(u, C.cx, C.cy, C.r * 0.36, 9, 4, 35, 70, 12, 1.1, ROSE);
  rosette(u, C.cx, C.cy, C.r * 1.08, 14, 6, 35, 105, 10, 1.0, TEAL);
  // the seal's ground: fine concentric guilloché around the foil
  const S = L.seal;
  rosette(u, S.cx, S.cy, S.r + 88, 9, 4, 35, 70, 9, 1.0, ROSE);

  // ── intaglio ink
  const ink = canvas(), g = ink.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#fff'; g.fillStyle = '#fff';
  frame(g, 9, 2.6);
  // the vignette's oval frame
  g.lineWidth = 7;
  g.beginPath(); g.ellipse(V.x + V.w / 2, V.y + V.h / 2, V.w / 2 + 44, V.h / 2 + 44, 0, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 1.3;
  g.beginPath(); g.ellipse(V.x + V.w / 2, V.y + V.h / 2, V.w / 2 + 60, V.h / 2 + 60, 0, 0, Math.PI * 2); g.stroke();
  // lettering
  // the title band: clear of the microprint above, and of the oval below,
  // with room for the italic f's tail between the two lines
  text(g, 'Proof', W / 2, 440, 190, { weight: 700, italic: true, align: 'center' });
  text(g, 'OF THE STATE OF THE XRP LEDGER', W / 2, 548, 40, { weight: 700, align: 'center', track: 16 });
  text(g, 'Everything printed on this proof was checked by the machine displaying it.',
       W / 2, 2096, 32, { italic: true, align: 'center' });
  text(g, 'Proof of ledger state.  Not currency.  No monetary value.',
       W / 2, 2134, 23, { align: 'center', track: 2 });
  // count block labels under the rosette
  text(g, 'signatures checked here', C.cx, C.cy + C.r + 110, 38, { italic: true, align: 'center' });
  text(g, `of ${n} on the list; ${quorum} make a quorum`, C.cx, C.cy + C.r + 160, 30, { align: 'center' });
  // microprint: the trusted key and the legend, running round the frame
  const mp = `TRUSTED KEY ${trustRoot} ${trustName.toUpperCase()}   PROOF OF LEDGER STATE NOT CURRENCY`;
  const m0 = L.microEnd, mu = L.micro;
  micro(g, mp, m0, mu, W - 2 * m0, 11);
  micro(g, mp, m0, H - mu, W - 2 * m0, 11);
  micro(g, mp, mu, m0, H - 2 * m0, 11, Math.PI / 2);
  micro(g, mp, W - mu, H - m0, H - 2 * m0, 11, -Math.PI / 2);
  // signature panel: a rule and the domain under each of the 35 cells
  const P = L.sig, cols = 18, cw = P.w / cols, rh = P.h / 2;
  g.lineWidth = 1.1;
  for (let i = 0; i < n; i++) {
    const row = i < cols ? 0 : 1, col = row ? i - cols : i;
    const x = P.x + col * cw + (row ? cw / 2 : 0), y = P.y + row * rh;
    g.beginPath(); g.moveTo(x + 8, y + rh - 30); g.lineTo(x + cw - 8, y + rh - 30); g.stroke();
    g.font = fontSpec(10, 600); g.textAlign = 'center';
    const label = fit(g, domainOf(validators[i]), cw - 12);
    g.fillText(label, x + cw / 2, y + rh - 14);
    g.lineWidth = 0.55; g.strokeText(label, x + cw / 2, y + rh - 14);
  }
  // around the watermark window and the seal
  const WM = L.water;
  g.lineWidth = 2.2;
  g.beginPath(); g.ellipse(WM.cx, WM.cy, WM.rx + 24, WM.ry + 24, 0, 0, Math.PI * 2); g.stroke();
  text(g, 'Hold to the light', WM.cx, WM.cy + WM.ry + 90, 34, { italic: true, align: 'center' });
  g.lineWidth = 3;
  g.beginPath(); g.arc(S.cx, S.cy, S.r + 16, 0, Math.PI * 2); g.stroke();
  arcText(g, 'QUORUM · ' + quorum + ' OF ' + n + ' · SIGNED THE SAME LEDGER · ', S.cx, S.cy, S.r + 38, -Math.PI / 2, 20, { track: 3 });
  // the security thread's printed companions: tick marks either side
  for (let y = m0; y < H - m0; y += 64) { g.fillRect(L.thread.x - 22, y, 8, 2); g.fillRect(L.thread.x + L.thread.w + 14, y + 32, 8, 2); }

  // pack underprint RGB + ink into one RGBA plate
  const plate = pack(under, ink);

  const foil = canvas(W / 4, H / 4), fg = foil.getContext('2d');
  fg.fillStyle = '#000'; fg.fillRect(0, 0, W / 4, H / 4);
  fg.fillStyle = '#fff';
  fg.beginPath(); fg.arc(S.cx / 4, S.cy / 4, S.r / 4, 0, Math.PI * 2); fg.fill();
  // the thread, windowed: it surfaces every other interval
  for (let y = L.microEnd; y + 78 <= H - L.microEnd; y += 150) fg.fillRect(L.thread.x / 4, y / 4, L.thread.w / 4, 78 / 4);

  const uv = canvas(W / 2, H / 2), ug = uv.getContext('2d');
  ug.fillStyle = '#000'; ug.fillRect(0, 0, W / 2, H / 2);
  const fr = rng(hexBytes(trustRoot));
  ug.lineCap = 'round';
  for (let i = 0; i < 260; i++) {
    const x = fr() * W / 2, y = fr() * H / 2, a = fr() * 6.28, l = 3 + fr() * 7;
    ug.strokeStyle = `rgba(${fr() < 0.5 ? 255 : 90},${140 + fr() * 115 | 0},${fr() < 0.5 ? 255 : 60},0.7)`;
    ug.lineWidth = 0.55;
    ug.beginPath(); ug.moveTo(x, y);
    ug.quadraticCurveTo(x + Math.cos(a) * l, y + Math.sin(a + 1) * l, x + Math.cos(a) * l * 1.6, y + Math.sin(a) * l * 1.6);
    ug.stroke();
  }
  // the trusted key glows under UV inside the window that holds its watermark
  ug.font = fontSpec(13, 700); ug.textAlign = 'center'; ug.fillStyle = 'rgb(255,220,120)';
  const wx = L.water.cx / 2, wy = (L.water.cy + L.water.ry - 150) / 2;
  ug.fillText('TRUSTED KEY', wx, wy);
  ug.fillText(short(trustRoot, 10, 8), wx, wy + 18);
  ug.fillText(trustName.toUpperCase(), wx, wy + 36);

  const water = canvas(W / 4, H / 4), wg = water.getContext('2d');
  wg.fillStyle = '#000'; wg.fillRect(0, 0, W / 4, H / 4);
  medallion(wg, WM.cx / 4, WM.cy / 4, WM.rx / 4 * 0.92, WM.ry / 4 * 0.92, hexBytes(trustRoot));
  wg.font = fontSpec(14, 700); wg.textAlign = 'center'; wg.fillStyle = 'rgba(255,255,255,.6)';
  wg.fillText(trustRoot.slice(0, 6) + '…' + trustRoot.slice(-6), WM.cx / 4, (WM.cy + WM.ry * 0.8) / 4);
  // the thread is a continuous dark line in transmitted light
  wg.fillStyle = '#fff';
  wg.fillRect(L.thread.x / 4 - 1, L.frameIn / 4, L.thread.w / 4 + 2, (H - 2 * L.frameIn) / 4);

  const back = buildBack({ trustRoot, trustName, validators, quorum, fountain });
  return { plate, foil, uv, water, back };
}

/** Pack an RGB canvas and a greyscale canvas into RGBA ImageData. */
function pack(rgb, a) {
  const w = rgb.width, h = rgb.height;
  const d = rgb.getContext('2d').getImageData(0, 0, w, h);
  const s = a.getContext('2d').getImageData(0, 0, w, h).data;
  for (let i = 3; i < d.data.length; i += 4) d.data[i] = s[i - 3];
  return d;
}

// ── the back: how this proof was checked ─────────────────────────────────────
function buildBack({ trustRoot, trustName, validators, quorum, fountain }) {
  const under = canvas(), u = under.getContext('2d');
  u.fillStyle = '#fff'; u.fillRect(0, 0, W, H);
  u.globalAlpha = 0.38; u.strokeStyle = fountain(u); u.lineWidth = 1.1;
  for (let y = 60; y < H - 50; y += 11) {
    u.beginPath();
    for (let x = 50; x <= W - 50; x += 12) {
      const yy = y + 3 * Math.sin(x / 71 - y / 37) + 1.5 * Math.sin(x / 23 + y / 19);
      x > 50 ? u.lineTo(x, yy) : u.moveTo(x, yy);
    }
    u.stroke();
  }
  u.globalAlpha = 1;
  braid(u, 90, 90, W - 180, H - 180, 30, 46, 9, 1.35, fountain(u));
  const ink = canvas(), g = ink.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#fff'; g.fillStyle = '#fff';
  frame(g, 6, 1.8);
  text(g, 'How this proof was checked', 330, 470, 118, { weight: 700, italic: true });
  const steps = [
    ['The paper', `One key is trusted, and it is built into this page: ${trustName}, ${short(trustRoot, 12, 8)}.`],
    ['The list', 'That key signed a list of validators. The signature was checked here.'],
    ['The keys', 'Each validator’s own key vouches for the key it signs with today.'],
    ['The signatures', 'Every validator’s signature on this ledger was checked here, one by one.'],
    ['The quorum', `${quorum} of the ${validators.length} listed validators must sign the same ledger.`],
    ['The ledger', 'Its header hashes to exactly what they signed. The state root comes from it.'],
    ['The account', 'Its entry hashes, node by node, up to that state root. Look one up to see it.'],
  ];
  steps.forEach(([h, body], i) => {
    const y = STEP_Y + i * STEP_DY;
    ruledText(g, String(i + 1), 360, y + 40, 92, { weight: 700, italic: true, align: 'center' });
    text(g, h, 470, y, 56, { weight: 600 });
    text(g, body, 470, y + 62, 34, { italic: true });
  });
  // the list itself, with a cell per validator for this ledger's tick
  const gx = 2250, gy = 600, cw = 380, rh = 70;
  text(g, 'The list', gx, gy - 70, 56, { weight: 600 });
  validators.forEach((v, i) => {
    const col = i % 3, row = (i / 3) | 0;
    const x = gx + col * cw, y = gy + row * rh;
    g.font = fontSpec(26, 500); g.textAlign = 'left'; g.fillStyle = '#fff';
    const name = fit(g, domainOf(v), cw - 64);
    g.fillText(name, x + 44, y + 30);
    g.lineWidth = 0.9; g.strokeStyle = '#fff'; g.strokeText(name, x + 44, y + 30);
    g.lineWidth = 1.4; g.strokeRect(x, y + 6, 28, 28);
  });
  text(g, 'Proof of ledger state.  Not currency.  No monetary value.', W / 2, 2134, 23, { align: 'center', track: 2 });
  return pack(under, ink);
}
export const BACK_GRID = { x: 2250, y: 600, cw: 380, rh: 70 };
const STEP_Y = 640, STEP_DY = 215;
const TICKS = [1850, 560, 120, STEP_DY * 6 + 150];
const ACCT_Y = L.ledger.y + 4 * 58;         // the account's rows, under the header's four

// ── per-ledger layer ─────────────────────────────────────────────────────────
/** Dynamic ink, drawn additively in pure primaries on black:
 *    R intaglio (autographs, the ledger block)   G red letterpress   B the count
 *  plus a half-size fluorescent layer (R names that fluoresce, G pencil). */
// the last ledger's ink, at a quarter strength, until this ledger's own replaces it
const GHOST = 'rgb(66,0,0)', FULL = 'rgb(255,0,0)';

export class Dynamic {
  constructor(validators, quorum) {
    this.c = canvas(); this.g = this.c.getContext('2d');
    this.uv = canvas(W / 2, H / 2); this.ug = this.uv.getContext('2d');
    this.bk = canvas(W, H); this.bg = this.bk.getContext('2d');
    this.validators = validators; this.quorum = quorum;
    this.dirty = []; this.uvDirty = false; this.bkDirty = false;
    this.inked = { sigs: new Map(), header: null, acct: null };   // what this ledger has inked so far
    this.ghostAccount = false;
    this.clear();
  }
  clear() {
    for (const [g, w, h] of [[this.g, W, H], [this.ug, W / 2, H / 2], [this.bg, W, H]]) {
      g.globalCompositeOperation = 'source-over'; g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    }
    this.dirty = [[0, 0, W, H]]; this.uvDirty = true; this.bkDirty = true;
  }
  /** New ledger: serial, the count at zero, and the last ledger's ink left as
   *  a faint ghost until this ledger's own replaces it, so nothing on the sheet
   *  blanks all at once. Only the regions a ledger writes are wiped and
   *  re-uploaded, not the whole sheet. */
  ledger(seq) {
    const P = L.sig, B = BACK_GRID;
    const front = [[L.serial.x - 30, L.serial.y - 130, 1000, 190], [P.x - 10, P.y - 10, P.w + 20, P.h + 20],
                   [L.ledger.x - 10, L.ledger.y - 40, 720, 380]];
    const backRects = [[B.x - 10, B.y - 10, B.cw * 3 + 20, B.rh * 12 + 30], TICKS];
    for (const [g, rects] of [[this.g, front], [this.bg, backRects]]) {
      g.globalCompositeOperation = 'source-over'; g.fillStyle = '#000';
      rects.forEach(r => g.fillRect(...r));
    }
    this.ug.globalCompositeOperation = 'source-over'; this.ug.fillStyle = '#000'; this.ug.fillRect(0, 0, W / 2, H / 2);
    if (!this.first) { this.first = true; this.clear(); }
    else { this.dirty.push(...front); this.bkRects = (this.bkRects || []).concat(backRects); this.uvDirty = true; }
    const last = this.inked;
    this.inked = { sigs: new Map(), header: null, acct: null };
    for (const [i, sig] of last.sigs) this.drawSig(i, sig, true);
    if (last.header) this.drawHeader(last.header, true);
    if (last.acct) this.drawAccount(...last.acct, true);
    this.ghostAccount = !!last.acct;
    const g = this.g;
    g.globalCompositeOperation = 'lighter';
    // grouped with thin spaces, as serials are: Bodoni's comma reads as a full stop at this size
    const digits = seq.toLocaleString('en-US').replace(/,/g, '\u2009');
    text(g, 'Ledger', L.serial.x, L.serial.y - 70, 34, { italic: true, fill: 'rgb(0,255,0)' });
    text(g, digits, L.serial.x, L.serial.y, 64, { weight: 700, fill: 'rgb(0,255,0)', track: 2 });
    this.count(0);
    this.seq = seq;
  }
  /** Signatures checked so far, in optically variable ink over the rosette. */
  count(k) {
    const C = L.count, g = this.g;
    const box = [C.cx - 230, C.cy - 170, 460, 300];
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#000'; g.fillRect(...box);
    g.globalCompositeOperation = 'lighter';
    // Bodoni's ball terminals read as decimal points when digits sit apart:
    // set them tight, as a single figure
    const size = 230, ds = String(k).split('');
    g.font = fontSpec(size, 800);
    const ws = ds.map(d => g.measureText(d).width), kern = size * 0.06;
    let x = C.cx - (ws.reduce((a, b) => a + b, 0) - kern * (ds.length - 1)) / 2;
    ds.forEach((d, i) => { text(g, d, x, C.cy + 84, size, { weight: 800, fill: 'rgb(0,0,255)' }); x += ws[i] - kern; });
    this.dirty.push(box);
  }
  /** One validator's signature on this ledger has been checked. */
  signed(i, sigBytes) {
    this.inked.sigs.set(i, sigBytes);
    this.drawSig(i, sigBytes, false);
    // and its tick on the back's list
    const b = BACK_GRID, bx = b.x + (i % 3) * b.cw, by = b.y + ((i / 3) | 0) * b.rh;
    const bg = this.bg;
    bg.globalCompositeOperation = 'lighter'; bg.strokeStyle = 'rgb(255,0,0)'; bg.lineWidth = 4; bg.lineCap = 'round';
    bg.beginPath(); bg.moveTo(bx + 5, by + 20); bg.lineTo(bx + 13, by + 30); bg.lineTo(bx + 30, by + 4); bg.stroke();
    this.bkRects = (this.bkRects || []).concat([[bx - 4, by - 4, 44, 44]]);
  }
  /** A validator's autograph and its fluorescent name, in full ink or as the
   *  last ledger's ghost; either replaces whatever the cell held. */
  drawSig(i, sigBytes, ghost) {
    const P = L.sig, cols = 18, cw = P.w / cols, rh = P.h / 2;
    const row = i < cols ? 0 : 1, col = row ? i - cols : i;
    const x = P.x + col * cw + (row ? cw / 2 : 0), y = P.y + row * rh;
    const g = this.g;
    g.globalCompositeOperation = 'source-over'; g.fillStyle = '#000'; g.fillRect(x, y, cw, rh);
    // painted over, not added: the pen's hundreds of overlapping segments would
    // otherwise build a ghost's quarter-strength ink back up to full
    g.strokeStyle = ghost ? GHOST : FULL; g.lineCap = 'round';
    autograph(g, x + 6, y + 10, cw - 12, rh - 48, sigBytes);
    this.dirty.push([x, y, cw, rh]);
    // its domain, in fluorescent ink: a spoke just inside the oval's edge, like
    // a mark on a dial, so 35 names never overlap and clear all the printing
    const V = L.vignette, n = this.validators.length;
    const a = -Math.PI / 2 + ((i + 0.5) / n) * Math.PI * 2;
    const cx = (V.x + V.w / 2) / 2, cy = (V.y + V.h / 2) / 2;
    const ex = cx + Math.cos(a) * (V.w / 2 - 16) / 2, ey = cy + Math.sin(a) * (V.h / 2 - 16) / 2;
    const ang = Math.atan2(ey - cy, ex - cx), left = Math.cos(ang) < 0;
    const ug = this.ug;
    ug.save();
    ug.translate(ex, ey);
    ug.rotate(left ? ang + Math.PI : ang);          // never upside down
    ug.globalCompositeOperation = 'source-over'; ug.fillStyle = '#000';
    ug.fillRect(left ? -1 : -91, -8, 92, 16);
    ug.font = fontSpec(9, 700); ug.fillStyle = ghost ? GHOST : FULL; ug.textBaseline = 'middle';
    ug.textAlign = left ? 'left' : 'right';         // the name runs inward from the edge
    ug.fillText(fit(ug, domainOf(this.validators[i]).toUpperCase(), 86), 0, 0);
    ug.restore();
    this.uvDirty = true;
  }
  /** Tick the back's numbered steps that hold for this ledger (1-based). */
  stepTicks(n) {
    const bg = this.bg;
    bg.globalCompositeOperation = 'lighter'; bg.strokeStyle = 'rgb(255,0,0)'; bg.lineWidth = 7; bg.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const y = STEP_Y + i * STEP_DY - 30, x = 1880;
      bg.beginPath(); bg.moveTo(x, y + 10); bg.lineTo(x + 18, y + 30); bg.lineTo(x + 52, y - 22); bg.stroke();
    }
    this.bkRects = (this.bkRects || []).concat([TICKS]);
  }
  /** The ledger block: number, hash, state root, close time. Inked only once
   *  the header has hashed to what the quorum signed. */
  header(h) {
    this.inked.header = h;
    this.drawHeader(h, false);
  }
  drawHeader(h, ghost) {
    const g = this.g, x = L.ledger.x, y = L.ledger.y, ink = ghost ? GHOST : FULL;
    const rect = [x - 10, y - 40, 720, 4 * 58];
    g.globalCompositeOperation = 'source-over'; g.fillStyle = '#000'; g.fillRect(...rect);
    g.globalCompositeOperation = 'lighter';
    const close = new Date((h.close + 946684800) * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const rows = [['hash', short(h.hash, 12, 12)], ['state root', short(h.stateRoot, 12, 12)],
                  ['closed', close], ['XRP in existence', xrpText(BigInt(h.drops) / 1000000n * 1000000n)]];
    const max = L.sig.x - 40 - (x + 210);            // the values end before the signatures begin
    rows.forEach(([k, v], j) => {
      text(g, k, x, y + j * 58, 24, { italic: true, fill: ink });
      g.font = fontSpec(24, 600);
      text(g, fit(g, v, max), x + 210, y + j * 58, 24, { weight: 600, fill: ink, stroke: 0.8 });
    });
    this.dirty.push(rect);
  }
  /** An account's balance as the relay reports it, in pencil: not ink,
   *  because nothing has proven it yet. It sits where the proven rows go. */
  pencil(addr, drops, note) {
    const ug = this.ug, x = L.ledger.x / 2, y = ACCT_Y / 2;
    this.clearPencil();
    ug.save();
    ug.globalCompositeOperation = 'lighter';
    ug.font = fontSpec(15, 500, true); ug.fillStyle = 'rgb(0,255,0)'; ug.textAlign = 'left';
    ug.fillText(drops === null ? `${short(addr, 8, 6)}: the relay found no such account`
                               : `${short(addr, 8, 6)} holds ${xrpText(drops)} XRP?`, x, y);
    ug.font = fontSpec(11, 500, true);
    ug.fillText(fit(ug, note, 350), x, y + 18);
    ug.restore();
    this.uvDirty = true;
  }
  clearPencil() {
    const ug = this.ug;
    ug.save(); ug.globalCompositeOperation = 'source-over'; ug.fillStyle = '#000';
    ug.fillRect(L.ledger.x / 2 - 10, ACCT_Y / 2 - 30, 380, 60);
    ug.restore();
    this.uvDirty = true;
  }
  /** An account's entry, proven against this ledger's state root: two rows
   *  of intaglio under the header's. `drops` is null when the tree proves the
   *  account is not there; `path` is the branch taken at each inner node. */
  account(addr, drops, path) {
    this.clearPencil();
    this.drawAccount(addr, drops, path, false);
    this.inked.acct = [addr, drops, path];
    this.ghostAccount = false;
  }
  drawAccount(addr, drops, path, ghost) {
    const g = this.g, x = L.ledger.x, y = ACCT_Y, ink = ghost ? GHOST : FULL;
    this.wipeAccount();
    g.globalCompositeOperation = 'lighter';
    const max = L.sig.x - 40 - (x + 210);
    const rows = [[short(addr, 6, 5), drops === null ? 'not in this ledger' : `${xrpText(drops)} XRP`],
                  ['its path', path.join(' \u203A ')]];
    rows.forEach(([k, v], j) => {
      text(g, k, x, y + j * 58, 24, { italic: true, fill: ink });
      g.font = fontSpec(24, 600);
      text(g, fit(g, v, max), x + 210, y + j * 58, 24, { weight: 600, fill: ink, stroke: 0.8 });
    });
  }
  /** The account's rows gone, and not carried to the next ledger as a ghost. */
  clearAccount() {
    this.wipeAccount();
    this.inked.acct = null; this.ghostAccount = false;
  }
  wipeAccount() {
    const r = [L.ledger.x - 10, ACCT_Y - 40, 720, 58 + 70];
    this.g.globalCompositeOperation = 'source-over'; this.g.fillStyle = '#000'; this.g.fillRect(...r);
    this.dirty.push(r);
  }
}
