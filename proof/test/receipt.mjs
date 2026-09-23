// Receipts, end to end through the relay, against mainnet: the anchor is a
// ledger proven here from live validations; receipts are built for
// transactions near and far (a flag ledger, and full history), checked by
// verifyReceipt, and then forged five ways, each of which must be refused.
// Run: node test/receipt.mjs   (RELAY=… to point elsewhere)
import { checkList, keyring, checkValidation, checkHeader, verifyReceipt, unhex, TRUST_ROOTS } from '../js/verify.js';
import { buildReceipt } from '../js/receipt.js';
import { sha512 } from '../vendor/noble/hashes/sha2.js';
const RELAY = process.env.RELAY || 'http://127.0.0.1:3783';
const get = async p => (await fetch(RELAY + p)).json();
const txid = blob => Buffer.from(sha512(Buffer.concat([Buffer.from('54584E00', 'hex'), Buffer.from(blob, 'hex')])).slice(0, 32)).toString('hex').toUpperCase();
const root = TRUST_ROOTS.ripple.key;

// the list, as the page gets it
const body = await get('/vl?src=ripple'), mf = (await get('/manifests')).manifests;
const list = checkList(body, Date.now() / 1000, root), ring = keyring(list, mf);

// an anchor: the newest ledger whose header a quorum of full validations signed
const led = new Map(), vals = new Map();
const ws = new WebSocket(RELAY.replace(/^http/, 'ws'));
ws.onmessage = e => {
  const f = JSON.parse(e.data);
  if (f.t === 'ledger' && f.header) led.set(f.seq, f);
  if (f.t === 'val') { const a = vals.get(f.seq) || []; a.push(f.data); vals.set(f.seq, a); }
};
let anchor = null;
for (let i = 0; i < 40 && !anchor; i++) {
  await new Promise(r => setTimeout(r, 1000));
  for (const seq of [...led.keys()].sort((a, b) => b - a)) {
    const h = checkHeader(led.get(seq).header);
    const good = (vals.get(seq) || []).filter(d => { const v = checkValidation(d, ring); return v.ok && v.full && v.idx >= 0 && v.hash === h.hash; });
    if (new Set(good.map(d => checkValidation(d, ring).idx)).size >= list.quorum) { anchor = { seq, hash: h.hash, header: led.get(seq).header, validations: good }; break; }
  }
}
ws.close();
if (!anchor) throw new Error('no anchor ledger with a quorum within 40 s');
console.log(`anchor: ledger ${anchor.seq}, ${anchor.validations.length} validations`);
const listed = { root: 'ripple', body, manifests: mf };

// transactions to prove: in the anchor itself, 100 back, ~a week back, and from 2021 (a flag ledger, and not)
const pickIn = async seq => {
  const l = await get(`/ledger-txs?ledger=${seq}`);
  const t = l.transactions.find(x => x.tx_blob.startsWith('120000')) || l.transactions[0];   // a Payment if there is one
  return { seq, hash: txid(t.tx_blob) };
};
const cases = [await pickIn(anchor.seq), await pickIn(anchor.seq - 100), await pickIn(anchor.seq - 150000),
               await pickIn(60000000), await pickIn(60000123)];
let good = null;
for (const c of cases) {
  const t0 = performance.now();
  const r = await buildReceipt({ relay: RELAY, txHash: c.hash, anchor, list: listed });
  const size = JSON.stringify(r).length;
  const v = verifyReceipt(r, root);
  const a = v.ok && (v.tx.delivered || v.tx.amount);
  const amt = !a ? '' : a.currency === 'XRP' ? `${Number(a.drops) / 1e6} XRP` : `${a.value} ${a.currency}`;
  console.log(`ledger ${c.seq} (${anchor.seq - c.seq} back): ${v.ok ? 'PROVEN' : 'REFUSED: ' + v.why}` +
    (v.ok ? ` ${v.tx.type} ${v.tx.result}${amt ? ' ' + amt : ''}, ${v.steps} header(s) walked, ${v.anchor.signers}/${v.anchor.listed} signed` : '') +
    ` | ${(size / 1024).toFixed(0)} KB, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  if (v.ok && r.chain && r.chain.headers.length > 2) good = r;
}

// forgeries: each must be refused
// the page checks with the pinned key of the publisher a receipt names, never a key from the file
const forge = (name, f) => { const r = structuredClone(good); f(r); const v = verifyReceipt(r, TRUST_ROOTS[r.root]?.key); console.log(`  forged ${name}: ${v.ok ? 'ACCEPTED (BAD)' : 'refused (' + v.why + ')'}`); };
forge('amount in the transaction', r => { const n = r.tx.nodes.at(-1); n.data = n.data.slice(0, 60) + (n.data[60] === '0' ? '1' : '0') + n.data.slice(61); });
forge('ledger in the chain', r => { const h = r.chain.headers; h[1] = h[1].slice(0, 20) + (h[1][20] === '0' ? '1' : '0') + h[1].slice(21); });
forge('too few signatures', r => { r.anchor.validations = r.anchor.validations.slice(0, 20); });
forge('another trusted key', r => { r.root = 'xrplf'; });
forge('another transaction\'s hash', r => { r.tx.hash = cases[0].hash; });
console.log('  (the key check trusts only the key passed in, never the one the receipt names:',
  verifyReceipt(good, TRUST_ROOTS.xrplf.key).ok ? 'ACCEPTED (BAD))' : 'refused under the other key)');
process.exit(0);
