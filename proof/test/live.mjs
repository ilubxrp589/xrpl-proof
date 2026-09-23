// Live acceptance test for js/verify.js against mainnet, straight from the
// local xrpld (no relay involved). Run: node design/proof/test/live.mjs
import { checkList, keyring, checkValidation, checkHeader, hexToNodeKey, nodeKeyToHex,
         accountKey, TRUST_ROOT } from '../js/verify.js';

const RPC = 'http://127.0.0.1:5005/', WS = 'ws://127.0.0.1:6006';
const rpc = async (method, params = {}) =>
  (await (await fetch(RPC, { method: 'POST', body: JSON.stringify({ method, params: [params] }) })).json()).result;

const t0 = performance.now();
const body = await (await fetch('https://vl.ripple.com')).json();
const list = checkList(body);
console.log('LIST', list.steps.map(s => `${s.ok ? 'ok' : 'FAIL'} ${s.step}: ${s.detail}`).join(' | '));
console.log(`  ${list.validators.length} validators, quorum ${list.quorum}, manifests ok:`,
            list.validators.filter(v => v.manifest?.ok).length);

// newer manifests, as the relay will supply them
const extra = [];
for (const v of list.validators) {
  const r = await rpc('manifest', { public_key: hexToNodeKey(v.master) });
  if (r?.manifest) extra.push(r.manifest);
}
const ring = keyring(list, extra);
console.log(`  signing keys known: ${ring.bySigning.size}/35  (${(performance.now() - t0).toFixed(0)} ms)`);

// round-trip the node-key codec on one key
const k0 = list.validators[0].master;
if (nodeKeyToHex(hexToNodeKey(k0)) !== k0) throw new Error('node key codec broken');

// tamper tests: a flipped bit anywhere must fail
const tamper = structuredClone(body);
const blob = Buffer.from(tamper.blob, 'base64'); blob[blob.length >> 1] ^= 1;
tamper.blob = blob.toString('base64');
let refused = false;
try { checkList(tamper); } catch (e) { refused = true; }
console.log('  tampered list refused:', refused);

const byHash = new Map();
let n = 0, forged = 0;
const ws = new WebSocket(WS);
ws.onopen = () => ws.send(JSON.stringify({ id: 1, command: 'subscribe', streams: ['validations'] }));
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.type !== 'validationReceived') return;
  const t = performance.now();
  const r = checkValidation(m.data, ring);
  n++;
  if (!byHash.has(r.hash)) byHash.set(r.hash, { seq: r.seq, ok: new Set(), bad: 0, unl: 0, us: [] });
  const g = byHash.get(r.hash);
  if (r.idx >= 0) { g.unl++; if (r.ok) g.ok.add(r.idx); else g.bad++; }
  g.us.push(performance.now() - t);
  // forge: flip one byte of the ledger hash inside the signed data
  if (r.ok && forged < 5) {
    const d = m.data.split('');
    const at = m.data.indexOf('51') + 10;
    d[at] = d[at] === '0' ? '1' : '0';
    if (checkValidation(d.join(''), ring).ok) throw new Error('FORGED VALIDATION ACCEPTED');
    forged++;
  }
};
await new Promise(r => setTimeout(r, 14000));
ws.close();

console.log(`VALIDATIONS ${n} received; ${forged} forged copies all refused`);
const rows = [...byHash.entries()].sort((a, b) => a[1].seq - b[1].seq);
for (const [h, g] of rows) {
  const ms = g.us.reduce((a, b) => a + b, 0) / g.us.length;
  console.log(`  ${g.seq} ${h.slice(0, 12)}…  verified ${g.ok.size}/35  bad ${g.bad}  quorum ${g.ok.size >= list.quorum ? 'MET' : '-'}  ~${ms.toFixed(2)} ms/check`);
}
// header check on the most-signed ledger
const [bestHash, best] = rows.reduce((a, b) => (b[1].ok.size > a[1].ok.size ? b : a));
const L = await rpc('ledger', { ledger_hash: bestHash, binary: true });
const hd = checkHeader(L.ledger.ledger_data);
console.log(`HEADER ${best.seq}: computed ${hd.hash.slice(0, 16)}… signed ${bestHash.slice(0, 16)}… match=${hd.hash === bestHash}`);
console.log(`  state root ${hd.stateRoot.slice(0, 16)}…  coins ${hd.drops}`);
console.log('ACCOUNT KEY (genesis) rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh →', accountKey('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'));
console.log('trust root', TRUST_ROOT.slice(0, 12) + '…');
process.exit(0);
