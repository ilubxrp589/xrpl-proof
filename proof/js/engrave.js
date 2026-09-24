/* The engraver's tools: canvas drawing for the engraved receipt
 * (receipt-art.js), kept from the certificate this page used to print, and
 * the small helpers the other drawings share: a generator seeded from bytes,
 * hex, and XRP amounts written exactly. */

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

export function canvas(w, h) {
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

/** Drops as XRP, exactly (no floating point), grouped with `sep`: thin spaces
 *  on the sheet, where Bodoni's comma reads as a full stop. */
export function xrpText(drops, sep = '\u2009') {
  const d = BigInt(drops), neg = d < 0n, a = neg ? -d : d;
  const whole = (a / 1000000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const frac = (a % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}
