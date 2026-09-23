/* Proof Note — the verifier.
 *
 * Everything the page shows as "checked" is checked HERE, on the visitor's
 * machine, from raw bytes. The relay that delivers those bytes is untrusted by
 * design: it can withhold data (which shows as missing signatures) but it
 * cannot forge a list, a key, a signature or a ledger without every check
 * below failing.
 *
 * The one thing trusted is TRUST_ROOT, the validator-list publisher's master
 * key, pinned in this file.
 *
 * Byte rules mirror crates/xrpl-node/src/unl_verify.rs and validation.rs:
 *   manifest    'MAN\0' ‖ fields minus sfSignature and sfMasterSignature
 *   validation  'VAL\0' ‖ fields minus sfSignature
 *   ledger      'LWR\0' ‖ 118-byte header
 *   ed25519 signs the raw message; secp256k1 signs its SHA-512Half.
 */
import { secp256k1 } from '../vendor/noble/curves/secp256k1.js';
import { ed25519 } from '../vendor/noble/curves/ed25519.js';
import { sha512, sha256 } from '../vendor/noble/hashes/sha2.js';

// The two list publishers a stock node trusts (its validators.txt pins exactly
// these). The visitor picks ONE; that key is the single trusted input.
export const TRUST_ROOTS = {
  ripple: { key: 'ED2677ABFFD1B33AC6FBC3062B71F1E8397C1505E1C42C64D11AD1B28FF73F4734', name: 'vl.ripple.com' },
  xrplf:  { key: 'ED42AEC58B701EEBB77356FFFEC26F83C1F0407263530F068C7C73D392C7E06FD1', name: 'unl.xrplf.org' },
};
export const TRUST_ROOT = TRUST_ROOTS.ripple.key;
export const TRUST_ROOT_NAME = TRUST_ROOTS.ripple.name;

const P_MANIFEST   = [0x4D, 0x41, 0x4E, 0x00];
const P_VALIDATION = [0x56, 0x41, 0x4C, 0x00];
const P_LEDGER     = [0x4C, 0x57, 0x52, 0x00];
const P_INNER      = [0x4D, 0x49, 0x4E, 0x00];
const P_LEAF       = [0x4D, 0x4C, 0x4E, 0x00];
const RIPPLE_EPOCH = 946684800;

// ── bytes ────────────────────────────────────────────────────────────────────
export const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
export function unhex(s) {
  if (s.length % 2) throw new Error('odd hex');
  const o = new Uint8Array(s.length / 2);
  for (let i = 0; i < o.length; i++) {
    const v = parseInt(s.substr(i * 2, 2), 16);
    if (Number.isNaN(v)) throw new Error('bad hex');
    o[i] = v;
  }
  return o;
}
export function unb64(s) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '==='.slice((t.length + 3) % 4));
  const o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o;
}
function cat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0), o = new Uint8Array(n);
  let k = 0;
  for (const p of parts) { o.set(p, k); k += p.length; }
  return o;
}
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
export const half = m => sha512(m).slice(0, 32);

// ── base58, XRPL alphabet ────────────────────────────────────────────────────
const B58 = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c === 'r') bytes.unshift(0); else break; }
  return new Uint8Array(bytes);
}
function b58encode(b) {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x === 0) s = 'r' + s; else break; }
  return s;
}
function checked(payload) { return sha256(sha256(payload)).slice(0, 4); }
/** Decode an XRPL base58check token; returns the payload after the type byte. */
export function decodeToken(s, typeByte) {
  const raw = b58decode(s);
  const body = raw.slice(0, -4), sum = raw.slice(-4);
  if (!eq(checked(body), sum)) throw new Error('checksum');
  if (body[0] !== typeByte) throw new Error('wrong token type');
  return body.slice(1);
}
export function encodeToken(payload, typeByte) {
  const body = cat([typeByte], payload);
  return b58encode(cat(body, checked(body)));
}
export const nodeKeyToHex = s => hex(decodeToken(s, 0x1C));   // n9…/nH… → 33-byte key
export const hexToNodeKey = h => encodeToken(unhex(h), 0x1C);
export const accountId = r => decodeToken(r, 0x00);           // r… → 20 bytes

// ── STObject walk ────────────────────────────────────────────────────────────
// Only the field types that occur in validations, manifests and ledger
// entries of interest are sized; anything else throws rather than guessing.
const FIXED = { 1: 2, 2: 4, 3: 8, 4: 16, 5: 32, 16: 1, 17: 20, 20: 12, 21: 24, 22: 48, 23: 64, 26: 20 };
function vl(b, i) {
  const b1 = b[i];
  if (b1 <= 192) return [b1, 1];
  if (b1 <= 240) return [193 + (b1 - 193) * 256 + b[i + 1], 2];
  if (b1 <= 254) return [12481 + (b1 - 241) * 65536 + b[i + 1] * 256 + b[i + 2], 3];
  throw new Error('bad VL');
}
/** Walk a serialized STObject. Yields {t, f, start, end, v} per field,
 *  where v is the value's bytes and [start,end) spans header+prefix+value. */
export function fields(b) {
  const out = [];
  let i = 0;
  while (i < b.length) {
    const start = i;
    let t = b[i] >> 4, f = b[i] & 15; i++;
    if (t === 0) t = b[i++];
    if (f === 0) f = b[i++];
    let len, pfx = 0;
    if (t in FIXED) len = FIXED[t];
    else if (t === 7 || t === 8 || t === 19) [len, pfx] = vl(b, i);
    else if (t === 6) len = (b[i] & 0x80) ? 48 : (b[i] & 0x20) ? 33 : 8;
    else throw new Error(`unsupported field type ${t}`);
    const vs = i + pfx, end = vs + len;
    if (end > b.length) throw new Error('truncated');
    out.push({ t, f, start, end, v: b.subarray(vs, end) });
    i = end;
  }
  return out;
}
const pick = (fs, t, f) => fs.find(x => x.t === t && x.f === f)?.v;
const u32 = v => ((v[0] << 24) >>> 0) + (v[1] << 16) + (v[2] << 8) + v[3];
/** The signing preimage: prefix plus every field except the listed ones. */
function preimage(prefix, b, fs, skip) {
  const keep = fs.filter(x => !skip.some(([t, f]) => x.t === t && x.f === f));
  return cat(prefix, ...keep.map(x => b.subarray(x.start, x.end)));
}

// ── signatures ───────────────────────────────────────────────────────────────
export function keyType(k) {
  if (k.length === 33 && k[0] === 0xED) return 'ed25519';
  if (k.length === 33 && (k[0] === 2 || k[0] === 3)) return 'secp256k1';
  return null;
}
export function verifySig(key, msg, sig) {
  try {
    const kt = keyType(key);
    if (kt === 'ed25519') return ed25519.verify(sig, msg, key.subarray(1));
    if (kt === 'secp256k1') {
      const s = secp256k1.Signature.fromDER(sig);
      return secp256k1.verify(s, half(msg), key, { lowS: false });
    }
  } catch (e) { /* malformed signature or key: not verified */ }
  return false;
}

// ── manifests ────────────────────────────────────────────────────────────────
/** A manifest binds a master key to its current signing key. Both
 *  signatures must hold; sequence 0xFFFFFFFF revokes the master key. */
export function checkManifest(bytes) {
  const fs = fields(bytes);
  const master = pick(fs, 7, 1), signing = pick(fs, 7, 3);
  const mSig = pick(fs, 7, 18), sig = pick(fs, 7, 6), seqV = pick(fs, 2, 4);
  const domainV = pick(fs, 7, 7);
  if (!master || !mSig || !seqV) throw new Error('manifest: missing fields');
  const seq = u32(seqV);
  const msg = preimage(P_MANIFEST, bytes, fs, [[7, 6], [7, 18]]);
  const out = {
    master: hex(master), signing: signing ? hex(signing) : null, seq,
    domain: domainV ? new TextDecoder().decode(domainV) : '',
    revoked: seq === 0xFFFFFFFF, masterOk: verifySig(master, msg, mSig),
    signingOk: false,
  };
  if (!out.revoked && signing && sig) out.signingOk = verifySig(signing, msg, sig);
  out.ok = out.masterOk && (out.revoked || out.signingOk);
  return out;
}

// ── the validator list ───────────────────────────────────────────────────────
/** Verify a publisher list (v1 or v2 body) against TRUST_ROOT.
 *  Returns the ordered chain of checks so the page can show each one. */
export function checkList(body, now = Date.now() / 1000, root = TRUST_ROOT) {
  const steps = [];
  const pub = checkManifest(unb64(body.manifest));
  steps.push({ step: 'publisher', ok: pub.ok && pub.master === root,
               detail: `publisher key ${pub.master.slice(0, 10)}…, manifest #${pub.seq}` });
  if (pub.master !== root || !pub.ok) throw Object.assign(new Error('the list is not signed by the trusted key'), { steps });
  const lists = body.blobs_v2 || [{ blob: body.blob, signature: body.signature, manifest: body.manifest }];
  const now_r = now - RIPPLE_EPOCH;
  let chosen = null;
  for (const L of lists) {
    const blob = unb64(L.blob);
    const signer = L.manifest ? checkManifest(unb64(L.manifest)) : pub;
    const ok = signer.ok && signer.master === root && !!signer.signing &&
               verifySig(unhex(signer.signing), blob, unhex(L.signature));
    const doc = JSON.parse(new TextDecoder().decode(blob));
    const live = (!doc.effective || doc.effective <= now_r) && (!doc.expiration || doc.expiration > now_r);
    if (ok && live && (!chosen || doc.sequence > chosen.doc.sequence)) chosen = { doc, ok };
  }
  if (!chosen) throw Object.assign(new Error('no list signed by the trusted key is in force'), { steps });
  const doc = chosen.doc;
  steps.push({ step: 'list', ok: true,
               detail: `list #${doc.sequence}, ${doc.validators.length} validators, expires ${new Date((doc.expiration + RIPPLE_EPOCH) * 1000).toISOString().slice(0, 10)}` });
  const validators = doc.validators.map(v => {
    let m = null;
    try { m = v.manifest ? checkManifest(unb64(v.manifest)) : null; } catch (e) { m = null; }
    const master = v.validation_public_key.toUpperCase();
    return { master, manifest: m && m.master === master ? m : null };
  });
  return { steps, sequence: doc.sequence, expiration: doc.expiration, validators,
           quorum: Math.ceil(validators.length * 0.8) };
}

/** Build signing-key → validator index, preferring the newest verified
 *  manifest per master key (the relay may supply newer ones than the list). */
export function keyring(list, extraManifests = []) {
  const byMaster = new Map(list.validators.map((v, i) => [v.master, i]));
  const best = list.validators.map(v => v.manifest && v.manifest.ok && !v.manifest.revoked ? v.manifest : null);
  for (const b64 of extraManifests) {
    let m;
    try { m = checkManifest(unb64(b64)); } catch (e) { continue; }
    const i = byMaster.get(m.master);
    if (i === undefined || !m.ok) continue;
    if (!best[i] || m.seq > best[i].seq) best[i] = m.revoked ? { ...m, signing: null } : m;
  }
  const bySigning = new Map();
  best.forEach((m, i) => { if (m && m.signing) bySigning.set(m.signing, i); });
  return { best, bySigning };
}

// ── validations ──────────────────────────────────────────────────────────────
/** Check one validation message from its raw bytes. Nothing from the
 *  relay's JSON wrapper is believed; every field comes from `data`. */
export function checkValidation(dataHex, ring) {
  const b = unhex(dataHex), fs = fields(b);
  const key = pick(fs, 7, 3), sig = pick(fs, 7, 6);
  const seqV = pick(fs, 2, 6), hashV = pick(fs, 5, 1), flagsV = pick(fs, 2, 2), timeV = pick(fs, 2, 9);
  if (!key || !sig || !seqV || !hashV) return { ok: false, why: 'malformed' };
  const signing = hex(key);
  const idx = ring.bySigning.get(signing);
  const out = { seq: u32(seqV), hash: hex(hashV), signing, idx: idx ?? -1,
                full: flagsV ? (u32(flagsV) & 1) === 1 : false,
                time: timeV ? u32(timeV) : 0, sig: sig.slice(0, 72) };
  if (idx === undefined) return { ...out, ok: false, why: 'not on the list' };
  out.ok = verifySig(key, preimage(P_VALIDATION, b, fs, [[7, 6]]), sig);
  if (!out.ok) out.why = 'bad signature';
  return out;
}

// ── ledger header ────────────────────────────────────────────────────────────
/** Hash the 118-byte header and split it into fields. */
export function checkHeader(headerHex) {
  const b = unhex(headerHex);
  if (b.length !== 118) throw new Error(`header is ${b.length} bytes, expected 118`);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    hash: hex(half(cat(P_LEDGER, b))),
    seq: dv.getUint32(0),
    drops: dv.getBigUint64(4).toString(),
    parent: hex(b.subarray(12, 44)), txRoot: hex(b.subarray(44, 76)),
    stateRoot: hex(b.subarray(76, 108)),
    parentClose: dv.getUint32(108), close: dv.getUint32(112),
    resolution: b[116], flags: b[117],
  };
}

// ── account proofs (SHAMap) ──────────────────────────────────────────────────
/** An AccountRoot's key in the state tree: SHA-512Half(0x0061 ‖ AccountID).
 *  Its hex digits ARE the path from the root: one nibble per level. */
export function accountKey(r) { return hex(half(cat([0x00, 0x61], accountId(r)))); }

/** Verify a proof path bottom-up. `path` is the list of inner nodes from the
 *  root down, each 16 child hashes (hex); `leaf` is the entry's serialized
 *  bytes. Returns the per-level results so the page can draw each hop. */
export function checkPath(stateRoot, keyHex, leafHex, path) {
  const key = unhex(keyHex);
  let h = hex(half(cat(P_LEAF, unhex(leafHex), key)));
  const hops = [];
  for (let d = path.length - 1; d >= 0; d--) {
    const nib = parseInt(keyHex[d], 16);
    const kids = path[d];
    const ok = kids[nib].toUpperCase() === h;
    h = hex(half(cat(P_INNER, ...kids.map(unhex))));
    hops.unshift({ depth: d, nibble: nib, ok, hash: h });
  }
  return { hops, ok: hops.every(x => x.ok) && h === stateRoot.toUpperCase() };
}

// ── balance proofs from rippled's own wire format ────────────────────────────
/** Verify a path through the state tree exactly as rippled serves it to peers
 *  (TMLedgerData node blobs, root first): each inner node must hash to what
 *  its parent says, the root to the state root this page already verified,
 *  and the last node must be the leaf for `keyHex`. Returns the per-level
 *  result so the page can draw each hop, and the leaf's data. */
export function checkProofWire(stateRootHex, keyHex, nodes) {
  const key = unhex(keyHex), K = keyHex.toUpperCase();
  let expected = stateRootHex.toUpperCase();
  const hops = [];
  for (let d = 0; d < nodes.length; d++) {
    if (nodes[d].depth !== d) return { ok: false, hops, why: `the path skips from depth ${d - 1} to ${nodes[d].depth}` };
    const b = unhex(nodes[d].data), type = b[b.length - 1];
    if (type === 2 || type === 3) {                       // inner node: full, or compressed
      const kids = Array.from({ length: 16 }, () => new Uint8Array(32));
      if (type === 2) {
        if (b.length !== 16 * 32 + 1) return { ok: false, hops, why: 'a malformed inner node' };
        for (let i = 0; i < 16; i++) kids[i] = b.subarray(i * 32, i * 32 + 32);
      } else {
        if ((b.length - 1) % 33) return { ok: false, hops, why: 'a malformed compressed node' };
        for (let o = 0; o + 33 <= b.length - 1; o += 33) {
          if (b[o + 32] > 15) return { ok: false, hops, why: 'a bad branch number' };
          kids[b[o + 32]] = b.subarray(o, o + 32);
        }
      }
      if (hex(half(cat(P_INNER, ...kids))) !== expected)
        return { ok: false, hops, why: `the node at depth ${d} does not hash to what ${d ? 'its parent' : 'the state root'} says` };
      const nib = (key[d >> 1] >> (d & 1 ? 0 : 4)) & 15;
      hops.push({ depth: d, nibble: nib });
      expected = hex(kids[nib]);
      if (/^0+$/.test(expected)) return { ok: false, absent: true, hops, why: 'this account is not in the ledger' };
    } else if (type === 1) {                              // an account-state leaf: data ‖ key
      const data = b.subarray(0, b.length - 33), kb = b.subarray(b.length - 33, b.length - 1);
      if (b.length < 34) return { ok: false, hops, why: 'a malformed entry' };
      if (hex(half(cat(P_LEAF, data, kb))) !== expected)
        return { ok: false, hops, why: 'the entry does not hash to what its parent says' };
      if (d !== nodes.length - 1) return { ok: false, hops, why: 'nodes follow the entry' };
      hops.push({ depth: d, leaf: true });
      // the only entry under this prefix is someone else's: rippled's own lookup
      // (walkTowardsKey) stops here too, so the account is not in the tree
      if (hex(kb) !== K) return { ok: false, absent: true, hops, why: 'this account is not in the ledger' };
      return { ok: true, hops, leaf: hex(data) };
    } else return { ok: false, hops, why: `an unknown node type ${type}` };
  }
  return { ok: false, hops, why: 'the path ended before reaching the account' };
}

/** Read an AccountRoot entry: it must be the entry for `r`, and its balance
 *  must be XRP. Returns the balance in drops (BigInt) and the sequence. */
export function accountRoot(leafHex, r) {
  const b = unhex(leafHex), fs = fields(b);
  const typ = pick(fs, 1, 1);
  if (!typ || ((typ[0] << 8) | typ[1]) !== 0x0061) throw new Error('the entry is not an account');
  const acct = pick(fs, 8, 1);
  if (!acct || hex(acct) !== hex(accountId(r))) throw new Error('the entry belongs to another account');
  const bal = pick(fs, 6, 2);
  if (!bal || bal.length !== 8 || (bal[0] & 0x80)) throw new Error('the balance is not in XRP');
  let v = 0n;
  for (const x of bal) v = (v << 8n) | BigInt(x);
  const drops = v & ((1n << 62n) - 1n);
  return { drops: (v >> 62n) & 1n ? drops : -drops, sequence: u32(pick(fs, 2, 4) || [0, 0, 0, 0]) };
}
