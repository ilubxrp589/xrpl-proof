// The tour's narrator in headless Chrome. The first visit opens the tour with
// no click yet, so the browser must refuse sound and the band offer to play
// it; a real click (a user gesture) then starts the voice, the next stop
// switches clips, and turning it off keeps it off.
// Usage: node test/voice.mjs [outdir]
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
const out = process.argv[2] || '/tmp/proof-voice';
const url = process.env.URL || 'http://127.0.0.1:8791/?dtmax=3';
mkdirSync(out, { recursive: true });
rmSync(`${out}/profile/DevToolsActivePort`, { force: true });
const log = openSync(`${out}/chrome.log`, 'w');
const chrome = spawn('google-chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${out}/profile`,
  '--window-size=1600,900', '--mute-audio', '--no-sandbox', '--disable-dev-shm-usage', '--no-zygote',
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
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') console.log('[exception]', (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 800));
};
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression, userGesture = false) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture })).result?.value;
await send('Runtime.enable');
await send('Page.navigate', { url });
for (let i = 0; i < 60 && !(await ev(`!!document.getElementById('tour') && !document.getElementById('tour').hidden`)); i++) await sleep(1000);
await sleep(1500);
const state = () => ev(`(() => { const t = window.__proof.tour(), b = document.getElementById('tour-voice');
  return JSON.stringify({ stop: document.body.dataset.tour, clip: t.voice.src.split('/').slice(-2).join('/'), playing: !t.voice.paused,
    at: +t.voice.currentTime.toFixed(1), length: +(t.voice.duration || 0).toFixed(1), button: b.textContent,
    pressed: b.getAttribute('aria-pressed'), speaking: b.hasAttribute('data-speaking') }); })()`);
if (!(await state())) console.log('probe failed:', JSON.stringify((await send('Runtime.evaluate', { expression: `typeof window.__proof + ' ' + typeof (window.__proof && window.__proof.tour) + ' ' + !!(window.__proof && window.__proof.tour && window.__proof.tour()) + ' tourHidden=' + document.getElementById('tour').hidden`, returnByValue: true })).result).slice(0, 300));
console.log('first visit, no click yet :', await state());
await ev(`document.getElementById('tour-next').click()`, true); await sleep(3500);
console.log('clicked Walk me through it:', await state());
await ev(`document.getElementById('tour-next').click()`, true); await sleep(2500);
console.log('clicked Next             :', await state());
await ev(`document.getElementById('tour-voice').click()`, true); await sleep(800);
console.log('turned narration off     :', await state());
await ev(`document.getElementById('tour-next').click()`, true); await sleep(2000);
console.log('clicked Next (stays off) :', await state(), '| remembered:', await ev(`localStorage.getItem('proof.narrate')`));
await ev(`document.getElementById('tour-voice').click()`, true); await sleep(2500);
console.log('turned it back on        :', await state());
await ev(`document.getElementById('tour-who').click()`, true); await sleep(2500);
console.log('switched voice           :', await state(), '| remembered:', await ev(`localStorage.getItem('proof.voice')`));
await ev(`document.getElementById('tour-skip').click()`, true); await sleep(800);
console.log('ended the tour           :', await state());
ws.close(); chrome.kill('SIGKILL'); process.exit(0);
