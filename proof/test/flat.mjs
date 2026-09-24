// Save the sheet's printed layers composed flat (front and back) as PNGs.
// Usage: node test/flat.mjs [url] [outdir] [seconds-to-wait]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
const url = process.argv[2] || 'http://127.0.0.1:8791/?dtmax=3';
const out = process.argv[3] || '/tmp/proof-flat';
const wait = +(process.argv[4] || 55);
mkdirSync(out, { recursive: true });
rmSync(`${out}/profile/DevToolsActivePort`, { force: true });   // a stale one would name an old port
const log = openSync(`${out}/chrome.log`, 'w');
const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${out}/profile`,
  '--window-size=1200,800', '--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--ignore-gpu-blocklist',
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', url], { stdio: ['ignore', log, log] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list, port;
for (let i = 0; i < 60 && !list; i++) {
  // port 0: Chrome picks a free port and writes it into the profile, so it never lands on a service
  try { port = readFileSync(`${out}/profile/DevToolsActivePort`, 'utf8').split('\n')[0]; list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); }
  catch { await sleep(250); }
}
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await sleep(wait * 1000);
for (const side of ['front', 'back']) {
  const r = await send('Runtime.evaluate', { expression: `window.__proof.flat('${side}')`, returnByValue: true, timeout: 120000 });
  const v = r.result && r.result.value;
  if (!v) { console.log(side, 'failed', JSON.stringify(r).slice(0, 300)); continue; }
  writeFileSync(`${out}/${side}.png`, Buffer.from(v.split(',')[1], 'base64'));
  console.log('saved', `${out}/${side}.png`);
}
ws.close(); chrome.kill('SIGKILL'); process.exit(0);
