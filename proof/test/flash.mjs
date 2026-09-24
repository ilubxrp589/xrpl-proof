// The change between ledgers must not flash. Traces the sky frame by frame
// across several ledger changes: the validators' mean light, the horizon and
// the heart must drain slowly and fill again, never snap to dark.
// Usage: node test/flash.mjs [outdir]   (TRACE_S: how long to watch)
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
const out = process.argv[2] || '/tmp/proof-flash';
const url = process.env.URL || 'http://127.0.0.1:8791/';
mkdirSync(out, { recursive: true });
rmSync(`${out}/profile/DevToolsActivePort`, { force: true });
const log = openSync(`${out}/chrome.log`, 'w');
const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${out}/profile`,
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
await send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'notour' });
for (let i = 0; i < 90; i++) { await sleep(1000); if (/header hashes to what they signed/.test(await ev(`document.getElementById('status').textContent`) || '')) break; }
await ev(`window.__proof.trace = []; window.__proof.tracing = true`);
await sleep(+(process.env.TRACE_S || 45) * 1000);
const tr = JSON.parse(await ev(`window.__proof.tracing = false, JSON.stringify(window.__proof.trace)`));
// each row: [time, ledger in view, mean light, horizon open, heart]
let swaps = 0, worst = 1, worstOpen = 1, worstHeart = 1;
for (let i = 1; i < tr.length; i++) {
  if (tr[i][1] === tr[i - 1][1] || tr[i - 1][2] < 0.9) continue;          // a change away from a fully lit ledger
  swaps++;
  const t0 = tr[i][0], after = tr.filter(r => r[0] >= t0 && r[0] <= t0 + 2.5);
  worst = Math.min(worst, ...after.map(r => r[2])); worstOpen = Math.min(worstOpen, ...after.map(r => r[3])); worstHeart = Math.min(worstHeart, ...after.map(r => r[4]));
}
console.log(`frames ${tr.length}, ledger changes from a fully lit gate ${swaps}; lowest mean light after a change ${worst.toFixed(2)}, horizon ${worstOpen.toFixed(2)}, heart ${worstHeart.toFixed(2)}`);
console.log(swaps && worst > 0.4 && worstOpen > 0.2 ? 'OK: no flash' : 'CHECK: it dims too far, or no change was seen');
ws.close(); chrome.kill('SIGKILL'); process.exit(0);
