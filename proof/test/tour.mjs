// Walk the tour in headless Chrome: a screenshot and the band's text at every
// stop, and the genesis lookup inked on the account stop. Usage: node test/tour.mjs [outdir]   (SHOT_W/SHOT_H set the window;
// MOBILE=1 emulates a phone at that size)
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
const out = process.argv[2] || '/tmp/proof-tour';
const url = process.env.URL || 'http://127.0.0.1:8791/?dtmax=3&tour';
const W = +(process.env.SHOT_W || 1600), H = +(process.env.SHOT_H || 900), mobile = !!process.env.MOBILE;
mkdirSync(out, { recursive: true });
rmSync(`${out}/profile/DevToolsActivePort`, { force: true });   // a stale one would name an old port
const log = openSync(`${out}/chrome.log`, 'w');
const chrome = spawn('google-chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${out}/profile`,
  `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio', '--no-sandbox', '--disable-dev-shm-usage', '--no-zygote',
  '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  ...(process.env.CHROME_FLAGS ? process.env.CHROME_FLAGS.split('|') : []), 'about:blank'], { stdio: ['ignore', log, log] });
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
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') console.log('[exception]', (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 1500));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type !== 'log') console.log(`[console.${m.params.type}]`, m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 800));
};
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
await send('Runtime.enable');
if (mobile) await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Page.navigate', { url });
for (let i = 0; i < 60 && !(await ev(`!!document.getElementById('tour') && !document.getElementById('tour').hidden`)); i++) await sleep(1000);
const band = () => ev(`[...document.querySelectorAll('#tour-num, #tour-title, #tour-body, #tour-live, #tour-next')].map(e => e.textContent).join(' | ')`);
const shot = async name => { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${out}/${name}.png`, Buffer.from(s.data, 'base64')); };
const settle = async (n = 7) => { for (let k = 0; k < n; k++) await sleep(900); };
for (let i = 0; i <= 7; i++) {
  if (i) await ev(`document.getElementById('tour-next').click()`);
  await settle(i === 0 ? 10 : 7);
  if (i === 6) {
    await ev(`document.getElementById('tour-genesis').click()`);
    for (let k = 0; k < 40 && !/In ink|Proven|Still in pencil/.test(await ev(`document.getElementById('tour-live').textContent`)); k++) await sleep(1000);
  }
  console.log(`stop ${i}:`, (await band()).slice(0, 420));
  console.log('        zoom', await ev(`JSON.stringify({ zoom: +document.body.classList.contains('zoomed'), mode: document.body.dataset.light, marks: [...document.querySelectorAll('.t-mark.on')].map(m => m.textContent + '@' + m.style.transform.replace(/translate|px|\\(|\\)/g, '')).join(' ') })`));
  await shot(`stop-${i}`);
}
await ev(`document.getElementById('tour-next').click()`);   // Done
await sleep(1500);
console.log('after:', await ev(`JSON.stringify({ touring: document.body.classList.contains('touring'), hidden: document.getElementById('tour').hidden, seen: localStorage.getItem('proof.toured'), light: document.body.dataset.light })`));
ws.close(); chrome.kill('SIGKILL'); process.exit(0);
