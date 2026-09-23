// Balance proof acceptance test: path from proof-peer, header from xrpld, both
// verified with the page's own code, and compared with account_info.
import { checkHeader, checkProofWire, accountRoot, accountKey, encodeToken } from '../js/verify.js';
const PEER = process.env.PEER || 'http://127.0.0.1:3784', RPC = 'http://127.0.0.1:5005/';
const rpc = async (method, p) => (await (await fetch(RPC, { method: 'POST', body: JSON.stringify({ method, params: [p] }) })).json()).result;
const accts = process.argv.slice(2).length ? process.argv.slice(2) : ['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', 'rrrrrrrrrrrrrrrrrrrrBZbvji']   // the genesis account, ACCOUNT_ONE;
const info = await rpc('server_info', {});
const h = info.info.validated_ledger.hash;
const hdr = checkHeader((await rpc('ledger', { ledger_hash: h, binary: true })).ledger.ledger_data);
console.log('ledger', hdr.seq, 'header hashes to', hdr.hash === h ? 'the validated hash' : 'SOMETHING ELSE', '| state root', hdr.stateRoot.slice(0, 12) + '…');
for (const r of accts) {
  const key = accountKey(r);
  const t0 = performance.now();
  const p = await (await fetch(`${PEER}/path?key=${key}&ledger=${h}`)).json();
  if (p.error) { console.log(r, 'relay error', p.error); continue; }
  const v = checkProofWire(hdr.stateRoot, key, p.nodes);
  if (!v.ok) { console.log(r, 'NOT PROVEN:', v.why); continue; }
  const a = accountRoot(v.leaf, r);
  const ai = await rpc('account_info', { account: r, ledger_hash: h });
  console.log(`${r}: PROVEN ${Number(a.drops) / 1e6} XRP in ${v.hops.length} steps, path ${v.hops.map(x => x.leaf ? '■' : x.nibble.toString(16).toUpperCase()).join('→')}, ${(performance.now() - t0).toFixed(0)} ms; account_info says ${Number(ai.account_data.Balance) / 1e6} → ${String(a.drops) === ai.account_data.Balance ? 'MATCH' : 'MISMATCH'}`);
  // tamper: flip one byte of the leaf's balance and of an inner node; both must fail
  const bad1 = structuredClone(p.nodes); const L = bad1[bad1.length - 1]; L.data = L.data.slice(0, 40) + (L.data[40] === '0' ? '1' : '0') + L.data.slice(41);
  const bad2 = structuredClone(p.nodes); bad2[2].data = bad2[2].data.slice(0, 10) + (bad2[2].data[10] === '0' ? '1' : '0') + bad2[2].data.slice(11);
  console.log('   tampered leaf refused:', !checkProofWire(hdr.stateRoot, key, bad1).ok, '| tampered inner node refused:', !checkProofWire(hdr.stateRoot, key, bad2).ok);
}
// an account that does not exist: the tree proves its absence
const ghost = encodeToken(crypto.getRandomValues(new Uint8Array(20)), 0);
const g = await (await fetch(`${PEER}/path?key=${accountKey(ghost)}&ledger=${h}`)).json();
const gv = g.nodes ? checkProofWire(hdr.stateRoot, accountKey(ghost), g.nodes) : g;
console.log('unfunded account', ghost, '→', gv.absent ? 'PROVEN ABSENT (empty branch under a verified node)' : JSON.stringify(gv).slice(0, 120));
process.exit(0);
