// Load the page in headless Chrome, print console output and errors, and save
// screenshots. Usage:
//   node test/shot.mjs [url] [outdir] [seconds...]
// e.g. node test/shot.mjs http://127.0.0.1:8791/ /tmp/shots 8 16
// Extra actions: SHOT_EVAL='js expression' is evaluated before each shot.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:8791/';
const out = process.argv[3] || '/tmp/proof-shots';
const times = (process.argv.slice(4).map(Number).filter(Boolean));
if (!times.length) times.push(10);
const W = +(process.env.SHOT_W || 1600), H = +(process.env.SHOT_H || 900);
mkdirSync(out, { recursive: true });
rmSync(`${out}/profile/DevToolsActivePort`, { force: true });   // a stale one would name an old port
const flags = [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${out}/profile`,
  `--window-size=${W},${H}`, '--hide-scrollbars', '--no-first-run', '--mute-audio',
  // this host's sandbox needs these, or Chrome hangs before opening the port
  '--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--enable-logging=stderr', '--v=0',
  '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', `--use-angle=${process.env.SHOT_GL || 'swiftshader'}`,
  ...(process.env.CHROME_FLAGS ? process.env.CHROME_FLAGS.split('|') : []),
];
import { openSync } from 'node:fs';
const errlog = openSync(`${out}/chrome.log`, 'w');
const chrome = spawn(process.env.CHROME || 'google-chrome', [...flags, url], { stdio: ['ignore', errlog, errlog] });
chrome.on('exit', (c, sig) => console.log('[chrome exited]', c, sig));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list, port;
for (let i = 0; i < 50 && !list; i++) {
  // port 0: Chrome picks a free port and writes it into the profile, so it never lands on a service
  try { port = readFileSync(`${out}/profile/DevToolsActivePort`, 'utf8').split('\n')[0]; list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); }
  catch { await sleep(200); }
}
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => (ws.onopen = r));
ws.onclose = () => console.log('[cdp socket closed]');
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') console.log(`[console.${m.params.type}]`, m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 2000));
  if (m.method === 'Runtime.exceptionThrown') console.log('[exception]', (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 3000));
  if (m.method === 'Log.entryAdded') console.log(`[log.${m.params.entry.level}]`, m.params.entry.text.slice(0, 600));
};
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
const t0 = Date.now();
for (const t of times) {
  await sleep(Math.max(0, t * 1000 - (Date.now() - t0)));
  // SHOT_EVALS: a JSON list, one expression per shot, run and then given
  // SHOT_SETTLE ms of frames before the picture is taken
  const evals = process.env.SHOT_EVALS ? JSON.parse(process.env.SHOT_EVALS) : [];
  const ex = evals[times.indexOf(t)] || process.env.SHOT_EVAL;
  if (ex) {
    const r = await send('Runtime.evaluate', { expression: ex, awaitPromise: true, returnByValue: true });
    console.log('[eval]', JSON.stringify(r.result?.value ?? r.result?.description ?? r).slice(0, 600));
    if (process.env.SHOT_SETTLE) await sleep(+process.env.SHOT_SETTLE);
  }
  const st = await send('Runtime.evaluate', { expression: "document.getElementById('status')?.textContent", returnByValue: true });
  console.log(`[t=${t}s status]`, st.result?.value);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const f = `${out}/shot-${t}s.png`;
  writeFileSync(f, Buffer.from(shot.data, 'base64'));
  console.log('saved', f);
}
ws.close(); chrome.kill('SIGKILL');
process.exit(0);
