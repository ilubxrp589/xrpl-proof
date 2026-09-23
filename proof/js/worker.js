/* The verifier runs here, off the main thread, so the checks never stutter
 * the animation. Every result the page draws comes back from this file. */
import { checkList, keyring, checkValidation, checkHeader, accountKey, checkProofWire, accountRoot, verifyReceipt, TRUST_ROOTS } from './verify.js';

let list = null, ring = null;

self.onmessage = e => {
  const m = e.data;
  try {
    if (m.t === 'list') {
      const root = TRUST_ROOTS[m.root] || TRUST_ROOTS.ripple;
      list = checkList(m.body, Date.now() / 1000, root.key);
      ring = keyring(list, m.manifests || []);
      self.postMessage({
        t: 'list', ok: true, steps: list.steps, sequence: list.sequence, expiration: list.expiration,
        quorum: list.quorum, root: m.root,
        validators: list.validators.map((v, i) => ({
          master: v.master, domain: (ring.best[i] && ring.best[i].domain) || (v.manifest && v.manifest.domain) || '',
          signing: ring.best[i] ? ring.best[i].signing : null,
        })),
      });
    } else if (m.t === 'val') {
      if (!ring) return;
      const r = checkValidation(m.data, ring);
      self.postMessage({ t: 'val', at: m.at, replay: m.replay, res: r, data: m.data });
    } else if (m.t === 'header') {
      self.postMessage({ t: 'header', seq: m.seq, claimed: m.hash, res: checkHeader(m.header) });
    } else if (m.t === 'receipt') {
      // checked with the pinned key of the publisher the receipt names, never a key from the file
      const root = TRUST_ROOTS[m.bundle && m.bundle.root];
      const res = root ? verifyReceipt(m.bundle, root.key) : { ok: false, why: 'it names a list publisher this page does not know' };
      if (root) res.publisher = root.name;
      self.postMessage({ t: 'receipt', id: m.id, res });
    } else if (m.t === 'proof') {
      // every node hashed up to the state root of a header this page already
      // checked; only then is the entry read
      const res = { ok: false };
      try {
        const v = checkProofWire(m.stateRoot, accountKey(m.addr), m.nodes);
        res.absent = !!v.absent; res.why = v.why;
        res.path = v.hops.map(h => (h.leaf ? '' : h.nibble.toString(16).toUpperCase()));
        if (v.ok) {
          const a = accountRoot(v.leaf, m.addr);
          Object.assign(res, { ok: true, drops: String(a.drops), sequence: a.sequence });
        }
      } catch (err) { res.why = String(err && err.message || err); }
      self.postMessage({ t: 'proof', seq: m.seq, addr: m.addr, res });
    }
  } catch (err) {
    self.postMessage({ t: m.t, ok: false, error: String(err && err.message || err), steps: err && err.steps });
  }
};
