// The failure path: the proof request is made to fail, so the balance must stay
// in pencil with the reason. Zooms onto the ledger block and saves the view.
// Usage: node test/pencil.mjs [address] [outdir]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
const addr = process.argv[2] || 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const out = process.argv[3] || '/tmp/proof-pencil';
const url = process.env.URL || 'http://127.0.0.1:8791/?dtmax=3';
mkdirSync(out, { recursive: true });
rmSync(`${out}/profile/DevToolsActivePort`, { force: true });   // a stale one would name an old port
const log = openSync(`${out}/chrome.log`, 'w');
const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${out}/profile`,
  '--window-size=1600,900', '--hide-scrollbars', '--mute-audio', '--no-sandbox', '--disable-dev-shm-usage', '--no-zygote',
  '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', url], { stdio: ['ignore', log, log] });
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
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m); pending.delete(m.id); return; }
  if (m.method === 'Fetch.requestPaused') send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'Failed' });
  if (m.method === 'Runtime.exceptionThrown') console.log('[exception]', (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 1500));
};
const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
await send('Runtime.enable');
await send('Fetch.enable', { patterns: [{ urlPattern: '*/path?*' }] });
for (let i = 0; i < 40 && !(await ev('!!(window.__proof && window.__proof.state().list)')); i++) await sleep(1000);
await ev(`document.getElementById('addr').value = '${addr}'; document.getElementById('addr-form').requestSubmit();`);
for (let i = 0; i < 4; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 520, y: 512, deltaX: 0, deltaY: -260 }); await sleep(400); }
let note = '';
for (let i = 0; i < 40 && !/Not proven/.test(note); i++) { await sleep(1500); note = await ev(`document.getElementById('addr-note').textContent`); }
console.log('note →', note);
await sleep(4000);
const s = await ev('JSON.stringify((({show, lantern}) => ({show, lantern}))(window.__proof.state()))');
console.log('state', s);
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(`${out}/view.png`, Buffer.from(shot.data, 'base64'));
ws.close(); chrome.kill('SIGKILL'); process.exit(0);
