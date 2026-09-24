// The receipt pictures, for looking at: real transactions, proven through the
// relay against mainnet as the page proves them (one in the ledger signed now,
// one 40 ledgers back, one from 2020, and from recent ledgers a failed one, an
// issued-currency payment and one with memos), each drawn by test/art.html in
// headless Chrome, in both looks. With FEW=n, n of the validators are shown as
// not having signed, to see empty sockets.
// Usage: node test/art.mjs [outdir]   (serve proof/ on 127.0.0.1:8791 first; RELAY=… to point elsewhere)
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, rmSync, openSync } from 'node:fs';
import { checkList, keyring, checkValidation, checkHeader, verifyReceipt, txDetails, TRUST_ROOTS } from '../js/verify.js';
import { buildReceipt } from '../js/receipt.js';
import { sha512 } from '../vendor/noble/hashes/sha2.js';
const out = process.argv[2] || '/tmp/proof-art', RELAY = process.env.RELAY || 'http://127.0.0.1:3783';
const get = async p => (await fetch(RELAY + p)).json();
const txid = blob => Buffer.from(sha512(Buffer.concat([Buffer.from('54584E00', 'hex'), Buffer.from(blob, 'hex')])).slice(0, 32)).toString('hex').toUpperCase();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const root = TRUST_ROOTS.ripple.key;
mkdirSync(out, { recursive: true });

// the list, and an anchor: the newest ledger whose header a quorum of full validations signed
const body = await get('/vl?src=ripple'), mf = (await get('/manifests')).manifests;
const list = checkList(body, Date.now() / 1000, root), ring = keyring(list, mf);
const led = new Map(), vals = new Map(), ws = new WebSocket(RELAY.replace(/^http/, 'ws'));
ws.onmessage = e => {
  const f = JSON.parse(e.data);
  if (f.t === 'ledger' && f.header) led.set(f.seq, f);
  if (f.t === 'val') { const a = vals.get(f.seq) || []; a.push(f.data); vals.set(f.seq, a); }
};
let anchor = null;
for (let i = 0; i < 40 && !anchor; i++) {
  await sleep(1000);
  for (const seq of [...led.keys()].sort((a, b) => b - a)) {
    const h = checkHeader(led.get(seq).header);
    const good = (vals.get(seq) || []).filter(d => { const c = checkValidation(d, ring); return c.ok && c.full && c.idx >= 0 && c.hash === h.hash; });
    if (new Set(good.map(d => checkValidation(d, ring).idx)).size >= list.quorum) { anchor = { seq, hash: h.hash, header: led.get(seq).header, validations: good }; break; }
  }
}
ws.close();
if (!anchor) { console.log('no ledger reached a quorum in 40 s'); process.exit(1); }
console.log('anchor: ledger', anchor.seq);

// the transactions
const cases = [['same', anchor.seq, t => t.tx_blob.startsWith('120000')], ['near', anchor.seq - 40, t => t.tx_blob.startsWith('120007')],
               ['far', 60000123, t => t.tx_blob.startsWith('120000')]];
const want = { failed: d => !d.succeeded, iou: d => d.type === 'Payment' && d.succeeded && d.amount && !['XRP', 'MPT'].includes(d.amount.currency),
               memo: d => d.succeeded && d.memos.length > 0 };
const found = {};
for (let s = anchor.seq - 2; s > anchor.seq - 30 && Object.keys(found).length < 3; s--) {
  for (const t of (await get(`/ledger-txs?ledger=${s}`)).transactions || []) {
    const d = txDetails(Buffer.from(t.tx_blob, 'hex'), Buffer.from(t.meta, 'hex'));
    for (const [k, f] of Object.entries(want)) if (!found[k] && f(d)) found[k] = [k, s, x => x.tx_blob === t.tx_blob];
  }
  await sleep(300);
}
cases.push(...Object.values(found));
const vs = {};
for (const [name, seq, pick] of cases) {
  const txs = (await get(`/ledger-txs?ledger=${seq}`)).transactions;
  const t = txs.find(pick) || txs[0];
  const v = verifyReceipt(await buildReceipt({ relay: RELAY, txHash: txid(t.tx_blob), anchor, list: { root: 'ripple', body, manifests: mf } }), root);
  if (!v.ok) { console.log(name, 'NOT PROVEN:', v.why); continue; }
  v.publisher = TRUST_ROOTS.ripple.name;
  if (+process.env.FEW) { v.anchor.signed = v.anchor.signed.filter((_, i) => i % Math.ceil(v.anchor.signed.length / +process.env.FEW)); v.anchor.signers = v.anchor.signed.length; }
  vs[name] = v;
  console.log(name, `${v.tx.type} ${v.tx.result}, ${v.steps} step(s) back`);
  await sleep(500);
}

// the pictures
rmSync(`${out}/profile/DevToolsActivePort`, { force: true });
const chrome = spawn('google-chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${out}/profile`, '--window-size=800,600',
  '--no-first-run', '--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', 'about:blank'], { stdio: ['ignore', openSync(`${out}/chrome.log`, 'w'), 'ignore'] });
let targets, port;
for (let i = 0; i < 60 && !targets; i++) {
  try { port = readFileSync(`${out}/profile/DevToolsActivePort`, 'utf8').split('\n')[0]; targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); }
  catch { await sleep(250); }
}
const cdp = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => (cdp.onopen = r));
let id = 0; const pending = new Map();
cdp.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') console.log('[exception]', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); cdp.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: process.env.URL || 'http://127.0.0.1:8791/test/art.html' });
for (let i = 0; i < 60; i++) { if ((await send('Runtime.evaluate', { expression: 'window.ready === true', returnByValue: true })).result?.value) break; await sleep(250); }
for (const style of ['space', 'engraved']) {
  for (const [name, v] of Object.entries(vs)) {
    const r = await send('Runtime.evaluate', { expression: `draw(${JSON.stringify(v)}, '${style}')`, awaitPromise: true, returnByValue: true });
    const url = r.result?.value;
    if (!url || !url.startsWith('data:image/png')) { console.log(style, name, 'NOT DRAWN', JSON.stringify(r).slice(0, 300)); continue; }
    writeFileSync(`${out}/${style}-${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
  }
  console.log(style, 'drawn:', Object.keys(vs).join(', '));
}
cdp.close(); chrome.kill('SIGKILL'); process.exit(0);
