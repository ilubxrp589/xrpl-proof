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
export function checkProofWire(stateRootHex, keyHex, nodes, tree = 'state') {
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
    } else if (type === 1 || type === 4) {                // a leaf: data ‖ key (1 account state, 4 transaction)
      if ((type === 4) !== (tree === 'tx')) return { ok: false, hops, why: 'an entry from the other tree' };
      const data = b.subarray(0, b.length - 33), kb = b.subarray(b.length - 33, b.length - 1);
      if (b.length < 34) return { ok: false, hops, why: 'a malformed entry' };
      if (hex(half(cat(type === 4 ? P_TXNODE : P_LEAF, data, kb))) !== expected)
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


// ── transactions, and receipts for them ─────────────────────────────────────
// Names from rippled 3.3.0 (TER.h, transactions.macro), for display only.
const TX_TYPES = { 0: 'Payment', 1: 'EscrowCreate', 2: 'EscrowFinish', 3: 'AccountSet', 4: 'EscrowCancel', 5: 'SetRegularKey', 7: 'OfferCreate', 8: 'OfferCancel', 10: 'TicketCreate', 12: 'SignerListSet', 13: 'PaymentChannelCreate', 14: 'PaymentChannelFund', 15: 'PaymentChannelClaim', 16: 'CheckCreate', 17: 'CheckCash', 18: 'CheckCancel', 19: 'DepositPreauth', 20: 'TrustSet', 21: 'AccountDelete', 25: 'NFTokenMint', 26: 'NFTokenBurn', 27: 'NFTokenCreateOffer', 28: 'NFTokenCancelOffer', 29: 'NFTokenAcceptOffer', 30: 'Clawback', 31: 'AMMClawback', 35: 'AMMCreate', 36: 'AMMDeposit', 37: 'AMMWithdraw', 38: 'AMMVote', 39: 'AMMBid', 40: 'AMMDelete', 41: 'XChainCreateClaimID', 42: 'XChainCommit', 43: 'XChainClaim', 44: 'XChainAccountCreateCommit', 45: 'XChainAddClaimAttestation', 46: 'XChainAddAccountCreateAttestation', 47: 'XChainModifyBridge', 48: 'XChainCreateBridge', 49: 'DIDSet', 50: 'DIDDelete', 51: 'OracleSet', 52: 'OracleDelete', 53: 'LedgerStateFix', 54: 'MPTokenIssuanceCreate', 55: 'MPTokenIssuanceDestroy', 56: 'MPTokenIssuanceSet', 57: 'MPTokenAuthorize', 58: 'CredentialCreate', 59: 'CredentialAccept', 60: 'CredentialDelete', 61: 'NFTokenModify', 62: 'PermissionedDomainSet', 63: 'PermissionedDomainDelete', 64: 'DelegateSet', 65: 'VaultCreate', 66: 'VaultSet', 67: 'VaultDelete', 68: 'VaultDeposit', 69: 'VaultWithdraw', 70: 'VaultClawback', 71: 'Batch', 74: 'LoanBrokerSet', 75: 'LoanBrokerDelete', 76: 'LoanBrokerCoverDeposit', 77: 'LoanBrokerCoverWithdraw', 78: 'LoanBrokerCoverClawback', 80: 'LoanSet', 81: 'LoanDelete', 82: 'LoanManage', 84: 'LoanPay', 85: 'ConfidentialMPTConvert', 86: 'ConfidentialMPTMergeInbox', 87: 'ConfidentialMPTConvertBack', 88: 'ConfidentialMPTSend', 89: 'ConfidentialMPTClawback', 90: 'SponsorshipTransfer', 91: 'SponsorshipSet', 100: 'EnableAmendment', 101: 'SetFee', 102: 'UNLModify' };
const RESULTS = { 0: 'tesSUCCESS', 100: 'tecCLAIM', 101: 'tecPATH_PARTIAL', 102: 'tecUNFUNDED_ADD', 103: 'tecUNFUNDED_OFFER', 104: 'tecUNFUNDED_PAYMENT', 105: 'tecFAILED_PROCESSING', 121: 'tecDIR_FULL', 122: 'tecINSUF_RESERVE_LINE', 123: 'tecINSUF_RESERVE_OFFER', 124: 'tecNO_DST', 125: 'tecNO_DST_INSUF_XRP', 126: 'tecNO_LINE_INSUF_RESERVE', 127: 'tecNO_LINE_REDUNDANT', 128: 'tecPATH_DRY', 129: 'tecUNFUNDED', 130: 'tecNO_ALTERNATIVE_KEY', 131: 'tecNO_REGULAR_KEY', 132: 'tecOWNERS', 133: 'tecNO_ISSUER', 134: 'tecNO_AUTH', 135: 'tecNO_LINE', 136: 'tecINSUFF_FEE', 137: 'tecFROZEN', 138: 'tecNO_TARGET', 139: 'tecNO_PERMISSION', 140: 'tecNO_ENTRY', 141: 'tecINSUFFICIENT_RESERVE', 142: 'tecNEED_MASTER_KEY', 143: 'tecDST_TAG_NEEDED', 144: 'tecINTERNAL', 145: 'tecOVERSIZE', 146: 'tecCRYPTOCONDITION_ERROR', 147: 'tecINVARIANT_FAILED', 148: 'tecEXPIRED', 149: 'tecDUPLICATE', 150: 'tecKILLED', 151: 'tecHAS_OBLIGATIONS', 152: 'tecTOO_SOON', 154: 'tecMAX_SEQUENCE_REACHED', 155: 'tecNO_SUITABLE_NFTOKEN_PAGE', 156: 'tecNFTOKEN_BUY_SELL_MISMATCH', 157: 'tecNFTOKEN_OFFER_TYPE_MISMATCH', 158: 'tecCANT_ACCEPT_OWN_NFTOKEN_OFFER', 159: 'tecINSUFFICIENT_FUNDS', 160: 'tecOBJECT_NOT_FOUND', 161: 'tecINSUFFICIENT_PAYMENT', 162: 'tecUNFUNDED_AMM', 163: 'tecAMM_BALANCE', 164: 'tecAMM_FAILED', 165: 'tecAMM_INVALID_TOKENS', 166: 'tecAMM_EMPTY', 167: 'tecAMM_NOT_EMPTY', 168: 'tecAMM_ACCOUNT', 169: 'tecINCOMPLETE', 170: 'tecXCHAIN_BAD_TRANSFER_ISSUE', 171: 'tecXCHAIN_NO_CLAIM_ID', 172: 'tecXCHAIN_BAD_CLAIM_ID', 173: 'tecXCHAIN_CLAIM_NO_QUORUM', 174: 'tecXCHAIN_PROOF_UNKNOWN_KEY', 175: 'tecXCHAIN_CREATE_ACCOUNT_NONXRP_ISSUE', 176: 'tecXCHAIN_WRONG_CHAIN', 177: 'tecXCHAIN_REWARD_MISMATCH', 178: 'tecXCHAIN_NO_SIGNERS_LIST', 179: 'tecXCHAIN_SENDING_ACCOUNT_MISMATCH', 180: 'tecXCHAIN_INSUFF_CREATE_AMOUNT', 181: 'tecXCHAIN_ACCOUNT_CREATE_PAST', 182: 'tecXCHAIN_ACCOUNT_CREATE_TOO_MANY', 183: 'tecXCHAIN_PAYMENT_FAILED', 184: 'tecXCHAIN_SELF_COMMIT', 185: 'tecXCHAIN_BAD_PUBLIC_KEY_ACCOUNT_PAIR', 186: 'tecXCHAIN_CREATE_ACCOUNT_DISABLED', 187: 'tecEMPTY_DID', 188: 'tecINVALID_UPDATE_TIME', 189: 'tecTOKEN_PAIR_NOT_FOUND', 190: 'tecARRAY_EMPTY', 191: 'tecARRAY_TOO_LARGE', 192: 'tecLOCKED', 193: 'tecBAD_CREDENTIALS', 194: 'tecWRONG_ASSET', 195: 'tecLIMIT_EXCEEDED', 196: 'tecPSEUDO_ACCOUNT', 197: 'tecPRECISION_LOSS', 198: 'tecNO_DELEGATE_PERMISSION', 199: 'tecBAD_PROOF', 200: 'tecNO_SPONSOR_PERMISSION' };
const P_TXNODE = [0x53, 0x4E, 0x44, 0x00];      // 'SND\0': a transaction-with-metadata leaf
const P_TXID   = [0x54, 0x58, 0x4E, 0x00];      // 'TXN\0': a transaction's own hash
const ZERO32 = new Uint8Array(32);
const nibble = (key, d) => (key[d >> 1] >> (d & 1 ? 0 : 4)) & 15;

/** A whole serialized STObject, nested objects and arrays included, as
 *  [{t, f, v}]: objects and arrays carry their children as `v`. */
export function stobject(b, i = 0, end = b.length, until = 0) {
  const out = [];
  while (i < end) {
    let t = b[i] >> 4, f = b[i] & 15; i++;
    if (t === 0) t = b[i++];
    if (f === 0) f = b[i++];
    if ((t === 14 || t === 15) && f === 1) {           // an object's or array's end marker
      if (t !== until) throw new Error('an end marker out of place');
      return [out, i];
    }
    if (t === 14 || t === 15) {
      const [kids, j] = stobject(b, i, end, t);
      out.push({ t, f, v: kids }); i = j; continue;
    }
    const s = i;
    if (t in FIXED) i += FIXED[t];
    else if (t === 7 || t === 8 || t === 19) { const [n, p] = vl(b, i); out.push({ t, f, v: b.subarray(i + p, i + p + n) }); i += p + n; continue; }
    else if (t === 6) i += (b[i] & 0x80) ? 48 : (b[i] & 0x20) ? 33 : 8;
    else if (t === 9) i += 12;                          // Number: 64-bit mantissa, 32-bit exponent
    else if (t === 10) i += 4;                          // Int32
    else if (t === 11) i += 8;                          // Int64
    else if (t === 18) {                                // PathSet: steps of account/currency/issuer, 0xFF between paths
      while (b[i] !== 0x00) { const k = b[i++]; if (k === 0xFF) continue; i += (k & 1 ? 20 : 0) + (k & 0x10 ? 20 : 0) + (k & 0x20 ? 20 : 0); if (i > end) break; }
      i++;
    } else if (t === 24) i = issueEnd(b, i);           // Issue
    else if (t === 25) {                                // XChainBridge: door, issue, door, issue
      for (let k = 0; k < 2; k++) { const [n, p] = vl(b, i); i = issueEnd(b, i + p + n); }
    } else throw new Error(`field type ${t} is not read here`);
    if (i > end) throw new Error('truncated');
    out.push({ t, f, v: b.subarray(s, i) });
  }
  if (until) throw new Error('an object or array without its end');
  return out;
}
function issueEnd(b, i) {
  if (b.subarray(i, i + 20).every(x => x === 0)) return i + 20;   // XRP
  const acct = b.subarray(i + 20, i + 40);
  const mpt = acct.subarray(0, 19).every(x => x === 0) && acct[19] === 1;   // noAccount marks an MPT
  return i + 40 + (mpt ? 4 : 0);
}
const get = (fs, t, f) => fs.find(x => x.t === t && x.f === f)?.v;

/** An Amount field: XRP drops, an issued currency, or an MPT. Exact, as text. */
export function amount(v) {
  if (!v) return null;
  let n = 0n;
  for (const x of v.subarray(v.length === 33 ? 1 : 0, v.length === 33 ? 9 : 8)) n = (n << 8n) | BigInt(x);
  if (v.length === 8) {
    const drops = n & ((1n << 62n) - 1n);
    return { currency: 'XRP', drops: String((n >> 62n) & 1n ? drops : -drops) };
  }
  if (v.length === 33) return { currency: 'MPT', value: String(n), id: hex(v.subarray(9)) };
  const mant = n & ((1n << 54n) - 1n), exp = Number((n >> 54n) & 0xFFn) - 97, neg = !((n >> 62n) & 1n);
  return { currency: currencyCode(v.subarray(8, 28)), issuer: encodeToken(v.subarray(28, 48), 0),
           value: mant === 0n ? '0' : (neg ? '-' : '') + decimalText(mant, exp) };
}
function decimalText(mant, exp) {
  let s = mant.toString();
  if (exp >= 0) return s + '0'.repeat(exp);
  s = s.padStart(-exp + 1, '0');
  const whole = s.slice(0, s.length + exp), frac = s.slice(s.length + exp).replace(/0+$/, '');
  return whole + (frac ? '.' + frac : '');
}
/** A currency code: three letters, or 20 bytes that often spell a longer name. */
export function currencyCode(c) {
  if (c.every(x => x === 0)) return 'XRP';
  if (c.subarray(0, 12).every(x => x === 0) && c.subarray(15).every(x => x === 0)) return String.fromCharCode(...c.subarray(12, 15));
  const t = [...c].filter(x => x).map(x => String.fromCharCode(x)).join('');
  return /^[\x20-\x7E]{3,20}$/.test(t) && c.subarray(t.length).every(x => x === 0) ? t : hex(c);
}
function text(v) {
  if (!v) return null;
  try { const s = new TextDecoder('utf-8', { fatal: true }).decode(v); if (!/[\x00-\x08\x0E-\x1F]/.test(s)) return s; } catch (e) { /* not text */ }
  return hex(v);
}
const u16 = v => (v[0] << 8) | v[1];

/** What a transaction did, read from its bytes and its metadata. */
export function txDetails(txBytes, metaBytes) {
  const tx = stobject(txBytes), meta = stobject(metaBytes);
  const acct = v => (v ? encodeToken(v, 0) : null), n32 = v => (v ? u32(v) : null);
  const type = u16(get(tx, 1, 2)), code = get(meta, 16, 3)[0];
  const memos = (get(tx, 15, 9) || []).map(m => ({ type: text(get(m.v, 7, 12)), data: text(get(m.v, 7, 13)), format: text(get(m.v, 7, 14)) }));
  return {
    type: TX_TYPES[type] || `type ${type}`, account: acct(get(tx, 8, 1)), destination: acct(get(tx, 8, 3)),
    amount: amount(get(tx, 6, 1)), delivered: amount(get(meta, 6, 18)), sendMax: amount(get(tx, 6, 9)),
    takerPays: amount(get(tx, 6, 4)), takerGets: amount(get(tx, 6, 5)), fee: amount(get(tx, 6, 8)),
    sequence: n32(get(tx, 2, 4)), destinationTag: n32(get(tx, 2, 14)), sourceTag: n32(get(tx, 2, 3)),
    invoiceId: get(tx, 5, 17) ? hex(get(tx, 5, 17)) : null, memos,
    result: RESULTS[code] || `result ${code}`, succeeded: code === 0, index: n32(get(meta, 2, 28)),
  };
}

/** A transaction-tree leaf's data (VL tx ‖ VL meta): checked against the
 *  transaction's hash, then read. */
export function txLeaf(dataHex, txHashHex) {
  const b = unhex(dataHex);
  const [n1, p1] = vl(b, 0), tx = b.subarray(p1, p1 + n1);
  const [n2, p2] = vl(b, p1 + n1), meta = b.subarray(p1 + n1 + p2, p1 + n1 + p2 + n2);
  if (p1 + n1 + p2 + n2 !== b.length) throw new Error('the entry is not a transaction with its metadata');
  if (hex(half(cat(P_TXID, tx))) !== txHashHex.toUpperCase()) throw new Error('the transaction does not hash to its hash');
  return txDetails(tx, meta);
}
function vlPrefix(n) {
  if (n <= 192) return [n];
  if (n <= 12480) { n -= 193; return [193 + (n >> 8), n & 255]; }
  n -= 12481; return [241 + (n >> 16), (n >> 8) & 255, n & 255];
}

/** A ledger's transaction tree rebuilt from all of its transactions: its
 *  root (which must equal the header's) and the path to any one of them, in
 *  the same wire format a peer sends, so the same check applies. */
export function txTree(items) {
  const leaves = items.map(({ tx, meta }) => {
    const key = half(cat(P_TXID, tx)), data = cat(vlPrefix(tx.length), tx, vlPrefix(meta.length), meta);
    return { key, data, hash: half(cat(P_TXNODE, data, key)) };
  });
  const build = (ls, d) => {
    if (d > 0 && ls.length === 1) return { leaf: ls[0], hash: ls[0].hash };
    const kids = Array.from({ length: 16 }, (_, n) => { const sub = ls.filter(l => nibble(l.key, d) === n); return sub.length ? build(sub, d + 1) : null; });
    return { kids, hash: half(cat(P_INNER, ...kids.map(k => (k ? k.hash : ZERO32)))) };
  };
  const root = build(leaves, 0);
  return {
    root: hex(root.hash),
    path(keyHex) {
      const key = unhex(keyHex), nodes = [];
      let node = root, d = 0;
      while (node && node.kids) {
        nodes.push({ depth: d, data: hex(cat(...node.kids.map(k => (k ? k.hash : ZERO32)), [2])) });
        node = node.kids[nibble(key, d)]; d++;
      }
      if (node) nodes.push({ depth: d, data: hex(cat(node.leaf.data, node.leaf.key, [4])) });
      return nodes;
    },
  };
}

/** The ledger-hash records every ledger's state keeps: the last 256 ledgers
 *  (keylet::skip()), and every 256th ledger, grouped by 65536 (keylet::skip(seq)). */
export const skipKey = () => hex(half(new Uint8Array([0x00, 0x73])));
export function skipKeyFor(seq) {
  const g = seq >>> 16;
  return hex(half(new Uint8Array([0x00, 0x73, g >>> 24 & 255, g >>> 16 & 255, g >>> 8 & 255, g & 255])));
}
export function ledgerHashes(leafHex) {
  const fs = stobject(unhex(leafHex));
  if (u16(get(fs, 1, 1)) !== 0x0068) throw new Error('the entry is not a record of ledger hashes');
  const hv = get(fs, 19, 2), hashes = [];
  for (let o = 0; o + 32 <= hv.length; o += 32) hashes.push(hex(hv.subarray(o, o + 32)));
  return { last: u32(get(fs, 2, 27)), hashes };
}

/** Check a receipt from its evidence alone, trusting only `rootKey`:
 *    the list, signed by that key and in force when the anchor ledger closed;
 *    a quorum of its validators signing the anchor ledger;
 *    the anchor's own record of earlier ledgers, down a chain of headers, each
 *    the parent of the one before, to the transaction's ledger;
 *    the transaction, in that ledger's transaction tree.
 *  A receipt is made by this same check, so it is judged by the code that made it. */
export function verifyReceipt(r, rootKey) {
  const fail = why => ({ ok: false, why });
  if (!r || r.proof !== 'xrpl-transaction-receipt') return fail('this is not a transaction receipt');
  const anchor = checkHeader(r.anchor.header);
  let list;
  try { list = checkList(r.list, anchor.close + RIPPLE_EPOCH, rootKey); }
  catch (e) { return fail(`the validator list does not check out: ${e.message}`); }
  const ring = keyring(list, r.manifests || []);
  const signers = new Set();
  for (const d of r.anchor.validations || []) {
    try { const v = checkValidation(d, ring); if (v.ok && v.full && v.idx >= 0 && v.hash === anchor.hash) signers.add(v.idx); } catch (e) { /* not one */ }
  }
  if (signers.size < list.quorum) return fail(`only ${signers.size} of the ${list.quorum} signatures a quorum needs`);
  let ledger = anchor, steps = 0;
  if (r.chain) {
    const p = checkProofWire(anchor.stateRoot, r.chain.key, r.chain.nodes, 'state');
    if (!p.ok) return fail(`the anchor's record of earlier ledgers does not check out: ${p.why}`);
    const lh = ledgerHashes(p.leaf), hs = r.chain.headers.map(checkHeader), first = hs[0];
    const flags = r.chain.key !== skipKey();
    if (flags && r.chain.key !== skipKeyFor(first.seq)) return fail('the record covers other ledgers');
    const back = flags ? (lh.last - first.seq) / 256 : lh.last - first.seq;
    if (!Number.isInteger(back) || back < 0 || back >= lh.hashes.length || lh.hashes[lh.hashes.length - 1 - back] !== first.hash)
      return fail(`ledger ${first.seq} is not in the anchor's record of earlier ledgers`);
    for (let i = 1; i < hs.length; i++)
      if (hs[i].hash !== hs[i - 1].parent || hs[i].seq !== hs[i - 1].seq - 1) return fail(`the chain of ledgers breaks at ${hs[i].seq}`);
    ledger = hs[hs.length - 1]; steps = hs.length;
  }
  const t = checkProofWire(ledger.txRoot, r.tx.hash, r.tx.nodes, 'tx');
  if (!t.ok) return fail(t.absent ? `the transaction is not in ledger ${ledger.seq}` : `the transaction's proof does not check out: ${t.why}`);
  let tx;
  try { tx = txLeaf(t.leaf, r.tx.hash); } catch (e) { return fail(e.message); }
  return {
    ok: true, tx, hash: r.tx.hash.toUpperCase(), steps,
    record: r.chain ? (r.chain.key === skipKey() ? 'last256' : 'flags') : null,
    ledger: { seq: ledger.seq, hash: ledger.hash, close: ledger.close + RIPPLE_EPOCH },
    anchor: { seq: anchor.seq, hash: anchor.hash, close: anchor.close + RIPPLE_EPOCH, signers: signers.size,
              listed: list.validators.length, quorum: list.quorum, signed: [...signers].sort((a, b) => a - b) },
    masters: list.validators.map(v => v.master),
    list: { sequence: list.sequence, expiration: list.expiration },
  };
}
