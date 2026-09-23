// The change between ledgers must not flash. Traces the temple's mean column
// ink frame by frame across several ledger changes (it must never snap to
// blank), then lays a new ledger over an inked one and checks, on the flat
// sheet, that the last ledger's autographs and rows remain as faint ghosts.
// Usage: node test/flash.mjs [outdir]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
const out = process.argv[2] || '/tmp/proof-flash';
const url = process.env.URL || 'http://127.0.0.1:8791/';
mkdirSync(out, { recursive: true });
rmSync(`${out}/profile/DevToolsActivePort`, { force: true });
const log = openSync(`${out}/chrome.log`, 'w');
const chrome = spawn('google-chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${out}/profile`,
  '--window-size=800,450', '--mute-audio', '--no-sandbox', '--disable-dev-shm-usage', '--no-zygote',
  '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', 'about:blank'], { stdio: ['ignore', log, log] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list, port;
for (let i = 0; i < 60 && !list; i++) {
  try { port = readFileSync(`${out}/profile/DevToolsActivePort`, 'utf8').split('\n')[0]; list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); }
  catch { await sleep(250); }
}
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, timeout: 120000 })).result?.value;
await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 450, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url }); await sleep(2000);
await ev(`localStorage.setItem('proof.toured', '1'); localStorage.setItem('proof.hinted', '1')`);
await send('Page.navigate', { url });
for (let i = 0; i < 90; i++) { await sleep(1000); if (/header hashes to what they signed/.test(await ev(`document.getElementById('status').textContent`) || '')) break; }
// 1. the ink across ledger changes
await ev(`window.__proof.trace = []; window.__proof.tracing = true`);
await sleep(+(process.env.TRACE_S || 45) * 1000);
const tr = JSON.parse(await ev(`window.__proof.tracing = false, JSON.stringify(window.__proof.trace)`));
let swaps = 0, worst = 1, worstDome = 1;
for (let i = 1; i < tr.length; i++) {
  if (tr[i][1] === tr[i - 1][1] || tr[i - 1][2] < 0.9) continue;          // a change away from a fully inked ledger
  swaps++;
  const t0 = tr[i][0], after = tr.filter(r => r[0] >= t0 && r[0] <= t0 + 2.5);
  worst = Math.min(worst, ...after.map(r => r[2])); worstDome = Math.min(worstDome, ...after.map(r => r[3]));
}
console.log(`frames ${tr.length}, ledger changes from a full temple ${swaps}; lowest column ink after a change ${worst.toFixed(2)}, lowest dome ink ${worstDome.toFixed(2)} (snapped to 0 before)`);
// 2. the ghosts: lay a new ledger over this inked one, and look at the flat sheet
const flat = await ev(`(() => { const d = window.__proof.dyn(); d.ledger(d.seq + 1); return window.__proof.flat('front'); })()`);
writeFileSync(`${out}/ghost.png`, Buffer.from(flat.split(',')[1], 'base64'));
console.log('saved', `${out}/ghost.png`);
ws.close(); chrome.kill('SIGKILL'); process.exit(0);
