#!/usr/bin/env node
/* proof-peer — fetches Merkle paths through a ledger's state tree, for the
 * Proof page's balance proofs.
 *
 * It talks to the local xrpld the way any other node on the network does: a
 * peer connection (TLS, the XRPL/2.2 handshake), then the ordinary sync
 * request every node answers, TMGetLedger for account-state nodes. It asks
 * for the nodes along one key's path, root to leaf, and hands back the raw
 * wire blobs. It proves nothing itself: the browser hashes every blob up to
 * the state root that the validators signed, so this service, like the
 * relay, never has to be trusted.
 *
 * No config change on the node is needed: TMGetLedger is how nodes sync, and
 * is not gated the way TMProofPathRequest ([ledger_replay]) is.
 *
 * Serves on 127.0.0.1:3784:  GET /path?key=<64 hex>&ledger=<64 hex>  and  /health
 * (the proof-feed relay proxies /path, for recent ledgers only)
 * Byte rules follow rippled 3.3.0: Handshake.cpp (shared value, headers),
 * Message.cpp (6-byte frame header), SHAMapNodeID (33-byte node ids).
 */
import tls from 'node:tls';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { secp256k1 } from '../proof/vendor/noble/curves/secp256k1.js';
import { sha512 } from '../proof/vendor/noble/hashes/sha2.js';
import { encodeToken, hex, unhex } from '../proof/js/verify.js';

const PEER = { host: process.env.PROOF_PEER_HOST || '127.0.0.1', port: +(process.env.PROOF_PEER_PORT || 51235) };
const LISTEN = +(process.env.PROOF_PEER_LISTEN || 3784);
const KEYFILE = path.join(os.homedir(), '.proof-peer.key');
const MT_PING = 3, MT_GET_LEDGER = 31, MT_LEDGER_DATA = 32;
const LI_AS_NODE = 2, MAX_DEPTH = 16;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── our node identity: a secp256k1 key, kept so a reservation (if ever needed) holds
let priv;
if (existsSync(KEYFILE)) priv = unhex(readFileSync(KEYFILE, 'utf8').trim());
else { priv = secp256k1.utils.randomPrivateKey(); writeFileSync(KEYFILE, hex(priv) + '\n', { mode: 0o600 }); }
const nodePublic = encodeToken(secp256k1.getPublicKey(priv, true), 0x1C);

// ── protobuf, the few fields this needs ─────────────────────────────────────
function varint(n) {
  const out = [];
  let v = BigInt(n);
  do { let b = Number(v & 0x7Fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return out;
}
function field(no, wire, payload) {
  const tag = varint((no << 3) | wire);
  if (wire === 0) return Buffer.from([...tag, ...varint(payload)]);
  const bytes = Buffer.from(payload);
  return Buffer.concat([Buffer.from([...tag, ...varint(bytes.length)]), bytes]);
}
function decode(buf) {
  const out = {};
  let i = 0;
  const rv = () => { let r = 0n, s = 0n, b; do { b = buf[i++]; r |= BigInt(b & 0x7F) << s; s += 7n; } while (b & 0x80); return r; };
  while (i < buf.length) {
    const tag = Number(rv()), no = tag >> 3, wire = tag & 7;
    let v;
    if (wire === 0) v = rv();
    else if (wire === 2) { const n = Number(rv()); v = buf.subarray(i, i + n); i += n; }
    else if (wire === 1) { v = buf.subarray(i, i + 8); i += 8; }
    else if (wire === 5) { v = buf.subarray(i, i + 4); i += 4; }
    else throw new Error('protobuf wire type ' + wire);
    (out[no] ||= []).push(v);
  }
  return out;
}
function frame(type, payload) {
  const h = Buffer.alloc(6);
  h.writeUInt32BE(payload.length & 0x0FFFFFFF, 0);   // top four bits: compression, none
  h.writeUInt16BE(type, 4);
  return Buffer.concat([h, payload]);
}

/** The node ids along a key's path: depth d keeps the key's first d nibbles. */
function pathIds(key) {
  const ids = [];
  for (let d = 0; d <= MAX_DEPTH; d++) {
    const id = Buffer.alloc(33);
    for (let n = 0; n < d; n++) {
      const nib = (key[n >> 1] >> (n & 1 ? 0 : 4)) & 15;
      id[n >> 1] |= n & 1 ? nib : nib << 4;
    }
    id[32] = d;
    ids.push(id);
  }
  return ids;
}

// ── the peer connection ─────────────────────────────────────────────────────
const st = { sock: null, up: false, since: 0, error: null, served: 0, requests: 0 };

function connect() {
  if (st.sock) return;
  const sock = tls.connect({ ...PEER, rejectUnauthorized: false, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' });
  st.sock = sock;
  let head = Buffer.alloc(0), upgraded = false, buf = Buffer.alloc(0);
  sock.once('secureConnect', () => {
    // rippled's shared value: SHA-512Half of the XOR of both Finished messages' SHA-512s
    const a = sha512(sock.getFinished()), b = sha512(sock.getPeerFinished());
    const shared = sha512(a.map((x, i) => x ^ b[i])).slice(0, 32);
    const sig = secp256k1.sign(shared, priv).toDERRawBytes();
    sock.write([
      'GET / HTTP/1.1', 'User-Agent: proof-peer/1.0', 'Upgrade: XRPL/2.2', 'Connection: Upgrade',
      'Connect-As: Peer', 'Crawl: private',
      `Network-Time: ${Math.floor(Date.now() / 1000) - 946684800}`,
      `Public-Key: ${nodePublic}`,
      `Session-Signature: ${Buffer.from(sig).toString('base64')}`,
      `Instance-Cookie: ${BigInt('0x' + randomBytes(8).toString('hex'))}`,
      '', ''].join('\r\n'));
  });
  sock.on('data', chunk => {
    if (!upgraded) {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      const status = head.subarray(0, head.indexOf('\r\n')).toString();
      if (!/ 101 /.test(status)) {
        st.error = `the node refused the peer connection: ${status}` +
          (/ 503 /.test(status) ? ' (its peer slots are full)' : '');
        log(st.error, head.subarray(end + 4, end + 300).toString());
        sock.destroy();
        return;
      }
      upgraded = true; st.up = true; st.since = Date.now(); st.error = null;
      log('peered with', `${PEER.host}:${PEER.port}`, 'as', nodePublic);
      buf = head.subarray(end + 4);
      send();
    } else {
      buf = Buffer.concat([buf, chunk]);
    }
    // frames: 4 bytes of size (top four bits compression), 2 of type
    while (buf.length >= 6) {
      if (buf[0] & 0xF0) { st.error = 'the node sent a compressed frame'; sock.destroy(); return; }
      const size = buf.readUInt32BE(0) & 0x0FFFFFFF, type = buf.readUInt16BE(4);
      if (buf.length < 6 + size) break;
      const body = buf.subarray(6, 6 + size);
      buf = buf.subarray(6 + size);
      onMessage(type, body);
    }
  });
  const down = why => {
    if (st.sock !== sock) return;
    st.sock = null; st.up = false;
    if (why) st.error = st.error || String(why);
    // nothing in flight or waiting will be answered on this connection
    const err = new Error(st.error || 'the peer connection closed');
    if (inflight) { clearTimeout(inflight.timer); for (const job of inflight.jobs.values()) job.fail(err); inflight = null; }
    for (const jobs of pending.values()) for (const job of jobs.values()) job.fail(err);
    pending.clear();
    setTimeout(connect, 5000);
  };
  sock.on('error', e => down(e.message));
  sock.on('close', () => down());
}

function onMessage(type, body) {
  if (type === MT_PING) {
    const m = decode(body);
    if (Number(m[1]?.[0] ?? 0) === 0) {           // a ping: answer it, so the node keeps us
      const seq = m[2]?.[0];
      st.sock.write(frame(MT_PING, Buffer.concat([field(1, 0, 1), ...(seq !== undefined ? [field(2, 0, seq)] : [])])));
    }
    return;
  }
  if (type !== MT_LEDGER_DATA || !inflight) return;
  const m = decode(body);
  if (Number(m[3]?.[0] ?? -1) !== LI_AS_NODE || hex(m[1]?.[0] || []) !== inflight.ledger) return;
  const round = inflight; inflight = null;
  clearTimeout(round.timer);
  if (m[6]) {
    const err = new Error(['', 'the node does not have that ledger', 'the node has none of those nodes', 'bad request'][Number(m[6][0])] || 'error ' + m[6][0]);
    for (const job of round.jobs.values()) job.fail(err);
  } else {
    const got = new Map();
    for (const n of m[4] || []) {
      const f = decode(n), id = f[2]?.[0];
      if (id && id.length === 33 && f[1]) got.set(Buffer.from(id).toString('hex'), Buffer.from(f[1][0]));
    }
    const seq = Number(m[2]?.[0] ?? 0);
    for (const job of round.jobs.values()) job.take(got, seq);
  }
  send();
}

// ── lookups: one request per ledger, cached ─────────────────────────────────
// Each TMGetLedger costs this peer a "moderate burden" charge on the node
// (250, spread over a 32-second window; the node warns at a balance of 5000).
// So every lookup for one ledger goes out in ONE request, and answers are
// cached: any number of visitors watching any number of accounts costs about
// one request per ledger close.
const TYPICAL_DEPTH = 7;          // where most entries sit in a ~7M-entry tree
const MAX_KEYS = 64, MAX_LEDGERS = 4, TIMEOUT_MS = 6000, GATHER_MS = 60;
const cache = new Map();          // ledger:key → { seq, nodes }
const hint = new Map();           // key → the depth its entry sat at last time
const pending = new Map();        // ledger → Map(key → job), waiting to be sent
let inflight = null, gather = null;

function remember(map, k, v, max) {
  map.delete(k); map.set(k, v);
  while (map.size > max) map.delete(map.keys().next().value);
}

/** Where a path stands: finished (it reaches the entry, or an empty branch or
 *  another entry that proves there is none), or it needs the next level down. */
function finished(nodes, key) {
  const last = nodes[nodes.length - 1];
  if (!last) return false;
  const b = last.data, type = b[b.length - 1], d = last.depth;
  if (type !== 2 && type !== 3) return true;       // an entry, or something the browser will refuse
  if (d >= MAX_DEPTH) return true;
  const nib = (key[d >> 1] >> (d & 1 ? 0 : 4)) & 15;
  if (type === 2) return b.subarray(nib * 32, nib * 32 + 32).every(x => x === 0);
  for (let o = 0; o + 33 <= b.length - 1; o += 33) if (b[o + 32] === nib) return false;
  return true;                                      // compressed, and no child on that branch
}

class Job {
  constructor(ledger, keyHex) {
    this.ledger = ledger; this.keyHex = keyHex; this.key = unhex(keyHex);
    this.ids = pathIds(this.key); this.nodes = []; this.from = 0; this.rounds = 0; this.waiters = [];
  }
  /** The node ids this lookup still needs: down to where its entry sat last
   *  time on the first round, then one level at a time. */
  want() {
    const to = this.rounds ? this.from : Math.max(this.from, hint.get(this.keyHex) ?? TYPICAL_DEPTH);
    return this.ids.slice(this.from, Math.min(MAX_DEPTH, to) + 1);
  }
  take(got, seq) {
    this.rounds++;
    let d = this.from;
    for (; d <= MAX_DEPTH; d++) {
      const data = got.get(this.ids[d].toString('hex'));
      if (!data) break;
      this.nodes.push({ depth: d, data });
    }
    this.from = d;
    if (!finished(this.nodes, this.key) && d > 0 && d <= MAX_DEPTH && this.rounds < 12) {
      queue(this);                                  // one level further down, next round
      return;
    }
    const out = { seq, nodes: this.nodes.map(n => ({ depth: n.depth, data: n.data.toString('hex').toUpperCase() })) };
    if (this.nodes.length) {
      remember(cache, this.ledger + ':' + this.keyHex, out, 4000);
      remember(hint, this.keyHex, this.nodes[this.nodes.length - 1].depth, 20000);
    }
    for (const w of this.waiters) w.resolve(out);
  }
  fail(err) { for (const w of this.waiters) w.reject(err); }
}

function queue(job) {
  let jobs = pending.get(job.ledger);
  if (!jobs) pending.set(job.ledger, jobs = new Map());
  jobs.set(job.keyHex, job);
  if (!gather) gather = setTimeout(() => { gather = null; send(); }, GATHER_MS);
}

function send() {
  if (inflight || !st.up || gather || !pending.size) return;
  const [ledger, jobs] = pending.entries().next().value;
  pending.delete(ledger);
  const ids = new Map();
  for (const job of jobs.values()) for (const id of job.want()) ids.set(id.toString('hex'), id);
  const body = Buffer.concat([
    field(1, 0, LI_AS_NODE), field(3, 2, unhex(ledger)),
    ...[...ids.values()].map(id => field(5, 2, id)), field(8, 0, 0),
  ]);
  inflight = { ledger, jobs, timer: setTimeout(() => {
    if (!inflight || inflight.ledger !== ledger) return;
    inflight = null;
    // the node sends nothing when it lacks the ledger, or is too busy to answer
    const err = new Error('the node did not answer in time');
    for (const job of jobs.values()) job.fail(err);
    send();
  }, TIMEOUT_MS) };
  st.requests++;
  st.sock.write(frame(MT_GET_LEDGER, body));
}

function fetchPath(keyHex, ledger) {
  const hit = cache.get(ledger + ':' + keyHex);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    if (!st.up) return reject(new Error(st.error || 'not connected to the node yet'));
    // join a lookup already on its way, if there is one
    let job = inflight && inflight.ledger === ledger && inflight.jobs.get(keyHex);
    job ||= pending.get(ledger)?.get(keyHex);
    if (!job) {
      if (!pending.has(ledger) && pending.size >= MAX_LEDGERS) return reject(new Error('busy: too many ledgers waiting'));
      if ((pending.get(ledger)?.size || 0) >= MAX_KEYS) return reject(new Error('busy: too many lookups for this ledger'));
      job = new Job(ledger, keyHex);
      queue(job);
    }
    job.waiters.push({ resolve, reject });
  });
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const reply = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  if (url.pathname.endsWith('/health'))
    return reply(200, { up: st.up, since: st.since, node: nodePublic, served: st.served, requests: st.requests,
                        cached: cache.size, error: st.error });
  if (!url.pathname.endsWith('/path')) return reply(404, { error: 'not found' });
  const key = (url.searchParams.get('key') || '').toUpperCase(), ledger = (url.searchParams.get('ledger') || '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(key) || !/^[0-9A-F]{64}$/.test(ledger)) return reply(400, { error: 'key and ledger must be 64 hex characters' });
  const t0 = Date.now();
  try {
    const r = await fetchPath(key, ledger);
    st.served++;
    // root first, one node per depth; the browser hashes every one of them
    reply(200, { ledger, seq: r.seq, key, nodes: r.nodes, ms: Date.now() - t0 });
  } catch (e) {
    reply(502, { error: e.message });
  }
}).listen(LISTEN, '127.0.0.1', () => log('proof-peer listening on 127.0.0.1:' + LISTEN, 'node key', nodePublic));

connect();
