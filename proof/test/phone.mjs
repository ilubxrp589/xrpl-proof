// The page on a phone (emulated: mobile viewport, touch, DPR 3): the tour's
// first stops, the plain page after the tour, a pinch, the legend.
// Usage: node test/phone.mjs [outdir]   (SHOT_W/SHOT_H: the viewport)
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
const out = process.argv[2] || '/tmp/proof-phone';
const url = process.env.URL || 'http://127.0.0.1:8791/?dtmax=3';
const W = +(process.env.SHOT_W || 390), H = +(process.env.SHOT_H || 844);
mkdirSync(out, { recursive: true });
rmSync(`${out}/profile/DevToolsActivePort`, { force: true });   // a stale one would name an old port
const log = openSync(`${out}/chrome.log`, 'w');
const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${out}/profile`,
  `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio', '--no-sandbox', '--disable-dev-shm-usage', '--no-zygote',
  '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', `--use-angle=${process.env.SHOT_GL || 'swiftshader'}`, 'about:blank'], { stdio: ['ignore', log, log] });
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
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 3, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Page.navigate', { url });
const shot = async name => { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${out}/${name}.png`, Buffer.from(s.data, 'base64')); console.log('shot', name); };
for (let i = 0; i < 60 && !(await ev(`!!window.__proof && window.__proof.state().list`)); i++) await sleep(1000);
await sleep(9000);
await shot('tour-0');
if (process.env.STOPS) {
  for (const k of process.env.STOPS.split(',').map(Number)) {
    await ev(`document.querySelectorAll('#tour-pips button')[${k - 1}].click()`); await sleep(7000); await shot(`tour-${k}`);
  }
}
await ev(`document.getElementById('tour-skip') && !document.getElementById('tour').hidden && document.getElementById('tour-skip').click()`);
await sleep(8000);
await shot('plain');
console.log('fps-ish', await ev(`window.__proof.frames`), 'status:', await ev(`document.getElementById('status').textContent`));
if (process.env.PINCH) {
  // two fingers spreading apart over the temple
  const cx = W / 2, cy = +process.env.PINCH;
  const pts = d => [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }];
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(20) });
  for (let d = 24; d <= 110; d += 6) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d) }); await sleep(60); }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(6000);
  await shot('pinched');
  console.log('zoom after pinch:', await ev(`document.body.classList.contains('zoomed')`));
}
if (process.env.DTAP) {
  // a double-tap zooms in on the spot; another goes back to the whole sheet
  // (pointer events made in the page: CDP's touch dispatch waits on each slow
  // software-GL frame, which spreads two taps further apart than any real ones)
  const t = async () => {
    await ev(`(() => {
      const gl = document.getElementById('gl'), o = { pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true,
        button: 0, buttons: 1, clientX: ${W / 2}, clientY: ${+process.env.DTAP} };
      for (let k = 0; k < 2; k++) { gl.dispatchEvent(new PointerEvent('pointerdown', o)); gl.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 })); }
    })()`);
    await sleep(4000);
    return ev(`document.body.classList.contains('zoomed')`);
  };
  if (await ev(`document.body.classList.contains('zoomed')`)) { await ev(`document.getElementById('fit').click()`); await sleep(3000); }
  console.log('double-tap zooms in:', await t(), '| again zooms out:', !(await t()));
}
if (process.env.AGAIN) {
  // the Tour button in the menu starts the tour over (a real tap, so the narrator may speak)
  const r = await send('Runtime.evaluate', { expression: `document.getElementById('tour-again').click()`, userGesture: true });
  await sleep(6000);
  console.log('Tour button:', await ev(`JSON.stringify({ touring: document.body.classList.contains('touring'), stop: document.body.dataset.tour,
    voice: document.getElementById('tour-voice').textContent, speaking: document.getElementById('tour-voice').hasAttribute('data-speaking') })`));
  await shot('again');
  await ev(`document.getElementById('tour-skip').click()`); await sleep(1500);
}
if (process.env.RECEIPT) {
  await ev(`window.__proof.proveTx('${process.env.RECEIPT}')`); await sleep(2000); await shot('receipt');
  console.log('receipt:', await ev(`document.getElementById('receipt').dataset.state`));
  await ev(`document.getElementById('rc-close').click()`);
}
await ev(`document.getElementById('help').click()`); await sleep(2500); await shot('legend');
ws.close(); chrome.kill('SIGKILL'); process.exit(0);
