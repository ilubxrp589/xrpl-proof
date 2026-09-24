/* The receipt, drawn for printing: an A4 sheet at 200 dpi in the certificate's
 * engraved style. Everything on it comes from a checked receipt (the result
 * of verifyReceipt), never from what the relay said. */
import { text, fontSpec, canvas, rng, hexBytes, xrpText, rosette, braid, micro, fit, INK, TEAL, ROSE } from './engrave.js';

export const RW = 1654, RH = 2339;
const PAPER = '#F6F4EA', SOFT = 'rgba(34,27,48,0.62)', FAINT = 'rgba(62,125,120,0.22)';
const group = x => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');   // thin spaces: Bodoni's comma reads as a full stop
export const utc = s => new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

/** An amount as words on a receipt: exact, grouped. */
export function amountText(a, sep = ' ') {
  if (!a) return '';
  if (a.currency === 'XRP') return `${xrpText(a.drops, sep)} XRP`;
  if (a.currency === 'MPT') return `${a.value} MPT`;
  const [w, f] = a.value.replace('-', '').split('.');
  const v = w.length > 21 ? Number(a.value).toPrecision(15) : (a.value.startsWith('-') ? '-' : '') + w.replace(/\B(?=(\d{3})+(?!\d))/g, sep) + (f ? '.' + f : '');
  return `${v} ${a.currency}`;
}

/** What the transaction did, in a line: the headline of the receipt. */
export function headline(tx) {
  const moved = tx.delivered || tx.amount;
  if (tx.type === 'Payment') return { lead: tx.succeeded ? 'A payment of' : 'A payment, not made, of', amount: moved };
  if (tx.type === 'OfferCreate') return { lead: 'An offer to trade', amount: tx.takerGets, then: tx.takerPays && `for ${amountText(tx.takerPays)}` };
  return { lead: `A ${tx.type} transaction`, amount: moved };
}

function wrap(g, s, max) {
  const lines = [];
  let cur = '';
  for (const w of s.split(' ')) {
    const t = cur ? `${cur} ${w}` : w;
    if (cur && g.measureText(t).width > max) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

export function drawReceipt(v) {
  const c = canvas(RW, RH), g = c.getContext('2d'), tx = v.tx, cx = RW / 2;
  const fountain = () => { const f = g.createLinearGradient(0, 0, RW, RH); f.addColorStop(0, TEAL); f.addColorStop(1, ROSE); return f; };
  g.fillStyle = PAPER; g.fillRect(0, 0, RW, RH);
  // underprint: fine wavy lines in the two inks, as on the certificate
  g.globalAlpha = 0.16; g.strokeStyle = fountain(); g.lineWidth = 1;
  for (let y = 60; y < RH - 50; y += 9) {
    g.beginPath();
    for (let x = 50; x <= RW - 50; x += 10) {
      const yy = y + 2.6 * Math.sin(x / 57 + y / 37) + 1.3 * Math.sin(x / 17 - y / 23);
      x > 50 ? g.lineTo(x, yy) : g.moveTo(x, yy);
    }
    g.stroke();
  }
  g.globalAlpha = 1;
  braid(g, 64, 64, RW - 128, RH - 128, 18, 38, 7, 1.15, fountain());
  // the frame: a heavy rule and a fine one, broken for four corner medallions
  const rule = (inset, lw) => {
    g.lineWidth = lw; g.strokeStyle = INK; g.beginPath();
    const a = inset, b = RW - inset, t = inset, u = RH - inset, gap = 52;
    g.moveTo(a + gap, t); g.lineTo(b - gap, t); g.moveTo(a + gap, u); g.lineTo(b - gap, u);
    g.moveTo(a, t + gap); g.lineTo(a, u - gap); g.moveTo(b, t + gap); g.lineTo(b, u - gap);
    g.stroke();
  };
  rule(118, 5); rule(136, 1.6);
  for (const [x, y] of [[127, 127], [RW - 127, 127], [127, RH - 127], [RW - 127, RH - 127]]) {
    g.strokeStyle = INK; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 38, 0, Math.PI * 2); g.stroke();
    rosette(g, x, y, 17, 5, 2, 8, 16, 3, 1, INK);
  }
  // microprint round the inside of the frame: the transaction's hash, over and over
  const mp = `XRPL TRANSACTION ${v.hash}   LEDGER ${v.ledger.seq}   PROOF OF A TRANSACTION   NOT CURRENCY   `;
  g.save(); g.fillStyle = INK; g.strokeStyle = INK;
  micro(g, mp, 190, 152, RW - 380, 9); micro(g, mp, 190, RH - 152, RW - 380, 9);
  micro(g, mp, 152, 190, RH - 380, 9, Math.PI / 2); micro(g, mp, RW - 152, RH - 190, RH - 380, 9, -Math.PI / 2);
  g.restore();

  // the title
  text(g, 'Receipt', cx, 360, 164, { weight: 700, italic: true, align: 'center', fill: INK });
  text(g, 'OF A TRANSACTION ON THE XRP LEDGER', cx, 438, 27, { weight: 700, align: 'center', track: 9, fill: INK });
  g.fillStyle = INK; g.fillRect(cx - 90, 478, 180, 2);

  // the headline: what happened, how much, between whom
  const h = headline(tx);
  text(g, h.lead, cx, 590, 42, { italic: true, align: 'center', fill: INK });
  g.font = fontSpec(104, 700);
  const big = h.amount ? amountText(h.amount) : tx.type;
  text(g, fit(g, big, RW - 420), cx, 720, 104, { weight: 700, align: 'center', fill: INK });
  let y = 720;
  if (h.amount && h.amount.issuer) { y += 52; text(g, `issued by ${h.amount.issuer}`, cx, y, 26, { italic: true, align: 'center', fill: SOFT }); }
  if (h.then) { y += 56; text(g, h.then, cx, y, 34, { italic: true, align: 'center', fill: INK }); }
  y += 88;
  text(g, 'from', cx, y, 30, { italic: true, align: 'center', fill: SOFT });
  text(g, tx.account, cx, y + 50, 36, { weight: 600, align: 'center', fill: INK, stroke: 0.6 });
  if (tx.destination) {
    text(g, 'to', cx, y + 118, 30, { italic: true, align: 'center', fill: SOFT });
    text(g, tx.destination, cx, y + 168, 36, { weight: 600, align: 'center', fill: INK, stroke: 0.6 });
    y += 118;
  }
  y += 150;
  const outcome = tx.succeeded ? 'Succeeded' : `Failed: ${tx.result}. The fee was still charged.`;
  text(g, outcome, cx, y, tx.succeeded ? 46 : 36, { italic: true, weight: 600, align: 'center', fill: tx.succeeded ? INK : '#8E2B22' });

  // the details
  y += 110;
  const L = 250, V = 560, max = RW - 250 - V;
  const rows = [
    ['Transaction', v.hash],
    ['Ledger', `${group(v.ledger.seq)}, closed ${utc(v.ledger.close)}`],
    ['Ledger hash', v.ledger.hash],
    ['Fee', amountText(tx.fee)],
    ['Sequence', tx.sequence ? group(tx.sequence) : 'a ticket'],
  ];
  if (tx.destinationTag !== null) rows.push(['Destination tag', String(tx.destinationTag)]);
  if (tx.sourceTag !== null) rows.push(['Source tag', String(tx.sourceTag)]);
  if (tx.invoiceId) rows.push(['Invoice ID', tx.invoiceId]);
  if (tx.delivered && tx.amount && amountText(tx.delivered) !== amountText(tx.amount)) rows.push(['Amount sent', amountText(tx.amount)]);
  for (const m of tx.memos.slice(0, 3)) rows.push([m.type && m.type.length < 24 ? `Memo (${m.type})` : 'Memo', m.data || '']);
  g.fillStyle = FAINT; g.fillRect(L, y - 48, RW - 2 * L, 1.5);
  for (const [k, val] of rows) {
    text(g, k, L, y, 26, { italic: true, fill: SOFT });
    // hashes whole: the type shrinks until all 64 characters fit (memos may still be cut)
    let size = 27;
    for (g.font = fontSpec(size, 600); size > 15 && g.measureText(val).width > max; ) g.font = fontSpec(--size, 600);
    text(g, fit(g, val, max), V, y, size, { weight: 600, fill: INK, stroke: 0.45 });
    y += 58;
  }
  g.fillStyle = FAINT; g.fillRect(L, y - 22, RW - 2 * L, 1.5);

  // the proof: the seal (one petal per listed validator, inked if it signed) and the account of the
  // checks, measured first, then centred between the details and the foot line
  const px = 610, pw = RW - 250 - px, sx = 390, R = 150;
  const said = `Ledger ${group(v.anchor.seq)} was signed by ${v.anchor.signers} of the ${v.anchor.listed} validators on the list published by ${v.publisher}, whose key is in the page that checked it; a quorum is ${v.anchor.quorum}. ` +
    (v.steps === 0 ? 'The transaction is in that ledger’s own transaction tree.'
      : `The transaction’s ledger was reached from it through ${v.steps === 1 ? 'its record of earlier ledgers' : `its record of earlier ledgers and ${v.steps - 1} more ledger headers, each the parent of the one before`}, and the transaction through that ledger’s transaction tree.`);
  g.font = fontSpec(25, 500);
  const sayLines = wrap(g, said, pw);
  g.font = fontSpec(24, 500, true);
  const checkLines = wrap(g, 'Check it yourself: drop this file on v2v.halcyon-names.io/proof. The evidence is attached inside this PDF, and the check needs nothing else.', pw);
  const textH = 62 + sayLines.length * 37 + 14 + checkLines.length * 35, blockH = Math.max(2 * R + 36, textH);
  const sy = y + Math.max(40, (RH - 250 - y - blockH) / 2) + blockH / 2;
  const signed = new Set(v.anchor.signed), n = v.masters.length;
  v.masters.forEach((m, i) => {
    const kr = rng(hexBytes(m)), a0 = (i / n) * Math.PI * 2 - Math.PI / 2;
    g.strokeStyle = signed.has(i) ? (i % 2 ? TEAL : '#35706B') : FAINT; g.lineWidth = 1.2;
    for (let k = 0; k < 5; k++) {
      g.beginPath();
      for (let s = 0; s <= 80; s++) {
        const t = s / 80, ang = a0 + (t - 0.5) * (Math.PI * 2 / n) * (2.2 + kr() * 0.6);
        const rr = R * 0.4 + R * 0.6 * Math.sin(Math.PI * t) ** (0.8 + k * 0.08) + 4 * Math.sin(t * 22 + k);
        const px = sx + Math.cos(ang) * rr, py = sy + Math.sin(ang) * rr;
        s ? g.lineTo(px, py) : g.moveTo(px, py);
      }
      g.stroke();
    }
  });
  g.strokeStyle = INK; g.lineWidth = 2.4; g.beginPath(); g.arc(sx, sy, R + 18, 0, Math.PI * 2); g.stroke();
  g.fillStyle = PAPER; g.beginPath(); g.arc(sx, sy, R * 0.36, 0, Math.PI * 2); g.fill();
  text(g, `${v.anchor.signers}`, sx, sy + 8, 64, { weight: 800, align: 'center', fill: INK });
  text(g, `of ${v.anchor.listed}`, sx, sy + 44, 22, { italic: true, align: 'center', fill: INK });

  let py = sy - textH / 2 + 40;
  text(g, 'Proven', px, py, 48, { weight: 600, italic: true, fill: INK });
  py += 62;
  for (const line of sayLines) { text(g, line, px, py, 25, { fill: INK }); py += 37; }
  py += 14;
  for (const line of checkLines) { text(g, line, px, py, 24, { italic: true, fill: SOFT }); py += 35; }
  text(g, 'Proof of a transaction.  Not currency.  No monetary value.', cx, RH - 196, 21, { align: 'center', track: 2, fill: INK });
  return c;
}
