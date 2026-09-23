// The receipt flow in headless Chrome: prove a transaction in the page, take
// the PDF it makes, check it with poppler, drop it back on the page to be
// checked, then drop a tampered copy, which must be refused.
// Usage: node test/receipt-ui.mjs [outdir] [ledger to take a transaction from]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { sha512 } from '../vendor/noble/hashes/sha2.js';
const out = process.argv[2] || '/tmp/proof-receipt-ui', fromLedger = +(process.argv[3] || 60000123);
const url = process.env.URL || 'http://127.0.0.1:8791/?dtmax=3', RELAY = 'http://127.0.0.1:3783';
mkdirSync(out, { recursive: true });
rmSync(`${out}/profile/DevToolsActivePort`, { force: true });
const txs = (await (await fetch(`${RELAY}/ledger-txs?ledger=${fromLedger}`)).json()).transactions;
const t = txs.find(x => x.tx_blob.startsWith('120000')) || txs[0];
const hash = Buffer.from(sha512(Buffer.concat([Buffer.from('54584E00', 'hex'), Buffer.from(t.tx_blob, 'hex')])).slice(0, 32)).toString('hex').toUpperCase();
console.log('proving', hash, 'from ledger', fromLedger);
const log = openSync(`${out}/chrome.log`, 'w');
const chrome = spawn('google-chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${out}/profile`,
  '--window-size=1440,900', '--mute-audio', '--no-sandbox', '--disable-dev-shm-usage', '--no-zygote',
  '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', 'about:blank'], { stdio: ['ignore', log, log] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list, port;
for (let i = 0; i < 60 && !list; i++) {
  try { port = readFileSync(`${out}/profile/DevToolsActivePort`, 'utf8').split('\n')[0]; list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); }
  catch { await sleep(250); }
}
const ws = new WebSocket(list.find(x => x.type === 'page').webSocketDebuggerUrl);
await new Promise(r => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') console.log('[exception]', (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 800));
};
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e, userGesture = false) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture, timeout: 180000 })).result?.value;
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url }); await sleep(2000);
await ev(`localStorage.setItem('proof.toured', '1'); localStorage.setItem('proof.hinted', '1')`);
await send('Page.navigate', { url });
for (let i = 0; i < 90; i++) { await sleep(1000); if (/header hashes to what they signed/.test(await ev(`document.getElementById('status').textContent`) || '')) break; }
const panel = () => ev(`(() => { const r = document.getElementById('receipt'); return r.dataset.state + ' | ' + [...r.querySelectorAll('p, dt, dd')].map(e => e.textContent).filter(Boolean).join(' | '); })()`);
await ev(`window.__proof.proveTx('${hash}')`);
console.log('panel:', (await panel()).slice(0, 700));
let s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${out}/panel.png`, Buffer.from(s.data, 'base64'));
// the PDF
await ev(`document.getElementById('rc-pdf').click()`, true);
let b64 = null;
for (let i = 0; i < 30 && !b64; i++) { await sleep(1000); b64 = await ev(`window.__proof.lastPdf ? (() => { const b = window.__proof.lastPdf; let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768)); return btoa(s); })() : null`); }
const pdf = Buffer.from(b64, 'base64'); writeFileSync(`${out}/receipt.pdf`, pdf);
console.log('pdf:', pdf.length, 'bytes');
// dropped back on the page: checked
await ev(`window.__proof.checkBytes(Uint8Array.from(atob('${b64}'), c => c.charCodeAt(0)), 'receipt.pdf')`);
console.log('re-checked:', (await panel()).slice(0, 160));
// tampered: one hex digit of the transaction's leaf changed inside the attached evidence
const txt = pdf.toString('latin1'), at = txt.indexOf('"tx":{"hash"'), leaf = txt.indexOf('"data":"', txt.lastIndexOf('"depth"', txt.indexOf(']}}', at)));
const bad = Buffer.from(pdf); const k = leaf + 8 + 40; bad[k] = bad[k] === 0x30 ? 0x31 : 0x30;
await ev(`window.__proof.checkBytes(Uint8Array.from(atob('${bad.toString('base64')}'), c => c.charCodeAt(0)), 'tampered.pdf')`);
console.log('tampered:', (await panel()).slice(0, 200));
s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${out}/tampered.png`, Buffer.from(s.data, 'base64'));
ws.close(); chrome.kill('SIGKILL'); process.exit(0);
