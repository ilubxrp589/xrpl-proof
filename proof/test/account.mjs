// Account proof in a real browser: look an address up, wait for the printed
// ledger's proof to ink, then save the 3D view and the flat front and back.
// Usage: node test/account.mjs [address] [outdir]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
const addr = process.argv[2] || 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const out = process.argv[3] || '/tmp/proof-account';
const url = process.env.URL || 'http://127.0.0.1:8791/?dtmax=3';
mkdirSync(out, { recursive: true });
rmSync(`${out}/profile/DevToolsActivePort`, { force: true });   // a stale one would name an old port
const log = openSync(`${out}/chrome.log`, 'w');
const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${out}/profile`,
  '--window-size=1600,900', '--hide-scrollbars', '--mute-audio', '--no-sandbox', '--disable-dev-shm-usage', '--no-zygote',
  '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  ...(process.env.CHROME_FLAGS ? process.env.CHROME_FLAGS.split('|') : []), url], { stdio: ['ignore', log, log] });
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
const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 120000 })).result?.value;
await send('Runtime.enable');
for (let i = 0; i < 40 && !(await ev('!!(window.__proof && window.__proof.state().list)')); i++) await sleep(1000);
// a typo first: the checksum must catch it
await ev(`(() => { const a = '${addr}'; document.getElementById('addr').value = a.slice(0, -1) + (a.endsWith('s') ? 't' : 's'); document.getElementById('addr-form').requestSubmit(); })()`);
await sleep(500);
console.log('typo  →', await ev(`document.getElementById('addr-note').textContent`));
await ev(`document.getElementById('addr').value = '${addr}'; document.getElementById('addr-form').requestSubmit();`);
let seen = '', done = false;
for (let i = 0; i < 90 && !done; i++) {
  await sleep(2000);
  const note = await ev(`document.getElementById('addr-note').textContent + ' | ' + document.getElementById('addr-path').textContent`);
  const s = await ev('JSON.stringify((({show, watch, lantern, acct}) => ({show, watch, lantern: +lantern.toFixed(2), acct: acct && {ok: acct.ok, absent: acct.absent, why: acct.why, drops: acct.drops}}))(window.__proof.state()))');
  if (note !== seen) { console.log(`t+${2 * i + 2}s`, note, '\n      ', s); seen = note; }
  done = /proven in this browser/.test(note) && JSON.parse(s).lantern > 0.5;
}
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(`${out}/view.png`, Buffer.from(shot.data, 'base64'));
// the flat sheet, taken in the same task as the check, so a new ledger cannot
// start (and wipe the rows) in between
for (const side of ['front', 'back']) {
  let v = null;
  for (let i = 0; i < 20 && !v; i++) {
    v = await ev(`(() => { const s = window.__proof.state(); return s.lantern > 0.9 && s.acct && (s.acct.ok || s.acct.absent) ? window.__proof.flat('${side}') : null; })()`);
    if (!v) await sleep(700);
  }
  if (v) writeFileSync(`${out}/${side}.png`, Buffer.from(v.split(',')[1], 'base64'));
  else console.log(side, ': no inked moment caught');
}
console.log(done ? 'INKED' : 'NOT INKED', '— saved', out);
ws.close(); chrome.kill('SIGKILL'); process.exit(0);
