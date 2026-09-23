/* Receipts: the evidence that one transaction is in a ledger the validators
 * signed, gathered from the untrusted relay into one self-contained bundle.
 * Nothing here decides anything. verifyReceipt (verify.js) checks the bundle,
 * the same check a downloaded receipt gets later, anywhere.
 *
 * The chain, from a ledger this page has just proven (the anchor, M) to the
 * transaction's ledger (N):
 *   N = M:            nothing between them;
 *   M - 256 <= N < M: M's record of its last 256 ledgers names N's hash;
 *   N older:          M's record of every 256th ledger names F, the first such
 *                     ledger at or after N, and headers F, F-1, … N follow,
 *                     each the parent of the one before.
 * Then N's whole transaction tree is rebuilt from its transactions, and the
 * path to this one kept. Works as far back as any server keeps history. */
import { skipKey, skipKeyFor, txTree, unhex } from './verify.js';

export async function buildReceipt({ relay, txHash, anchor, list, step = () => {} }) {
  const get = async p => {
    const r = await fetch(relay + p);
    const j = await r.json().catch(() => ({ error: `the relay answered ${r.status}` }));
    if (j.error) throw new Error(j.error);
    return j;
  };
  const n = x => x.toLocaleString('en-US');
  txHash = txHash.toUpperCase();
  step('Finding the transaction…');
  const t = await get(`/tx?hash=${txHash}`);
  const N = t.ledger_index, M = anchor.seq;
  if (N > M) throw new Error('that transaction is newer than the last ledger proven here. Try again in a few seconds');
  let chain = null;
  if (N < M) {
    const far = M - N > 256;
    const F = !far || N % 256 === 0 ? N : (Math.floor(N / 256) + 1) * 256;
    const key = far ? skipKeyFor(F) : skipKey();
    step(`Finding ledger ${n(F)} in the record kept by ledger ${n(M)}…`);
    const p = await get(`/path?key=${key}&ledger=${anchor.hash}`);
    step(F > N ? `Walking back ${F - N} ledgers to ledger ${n(N)}…` : `Fetching ledger ${n(N)}…`);
    const h = await get(`/headers?from=${F}&to=${N}`);
    chain = { key, nodes: p.nodes, headers: h.headers };
  }
  step(`Rebuilding ledger ${n(N)}'s transaction tree…`);
  const l = await get(`/ledger-txs?ledger=${N}`);
  const tree = txTree(l.transactions.map(x => ({ tx: unhex(x.tx_blob), meta: unhex(x.meta) })));
  return {
    proof: 'xrpl-transaction-receipt', version: 1, made: new Date().toISOString(),
    root: list.root, list: list.body, manifests: list.manifests,
    anchor: { header: anchor.header, validations: anchor.validations },
    chain, tx: { hash: txHash, nodes: tree.path(txHash) },
  };
}
