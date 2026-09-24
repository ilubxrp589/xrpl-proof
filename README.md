# Proof

The XRP Ledger, checked by the browser that displays it, and drawn in Deep Field's sky.

Every few seconds the XRP Ledger's validators agree on a new ledger and sign it. This page takes nobody's word for it. In your browser it checks the validator list against one publisher key, every validator's signature, the quorum and the ledger header, and lights only what passed: a gate with one light for each validator, around an event horizon that opens at the quorum. Look up an account and its balance is proven too, hashed node by node up to the state root the validators signed.

**Live:** https://v2v.halcyon-names.io/proof/

Light means checked here. An outline means someone else said so.

## What your browser checks, and where you see it

| Step | Check | In the sky |
|---|---|---|
| The key | The validator list must be signed by a publisher key built into the page: `vl.ripple.com` (`ED2677AB…`) or `unl.xrplf.org` (`ED42AEC5…`), the two keys a stock node trusts. You choose which. | The gold star. |
| The list | The list's signature and expiry, and every validator's manifest: each master key vouching for the key it signs with today. | The gate, drawn only once the list checks out, with one light per validator. |
| The signatures | Each validation's secp256k1 signature, over exactly the bytes the validator signed. Partial validations don't count. | A validator's light comes on; beyond it, its spectrum: lines set by the bytes it signed. |
| The quorum | At least 80% of the listed validators (28 of 35 today) must sign the same ledger hash. | The event horizon opens, as in Deep Field. |
| The ledger | The ledger header must hash (SHA-512Half with the `LWR\0` prefix) to exactly the hash they signed. The state root comes from that header. | The heart of the horizon lights, and the ledger joins the rings behind the gate: one for each ledger proven while you watch. |
| An account | The nodes from that state root down to the account's entry, in rippled's own wire format, each one hashed and checked. An account that doesn't exist is proven missing. | A body beyond the gate: an outline while it is only the relay's word, lit, with its path through the state tree, once proven. |

All of it runs in a Web Worker, using [@noble/curves](https://github.com/paulmillr/noble-curves) and [@noble/hashes](https://github.com/paulmillr/noble-hashes), vendored in `proof/vendor/`. The column on the left of the page says the same in words, for the ledger in view.

## Receipts for any transaction

Paste a transaction hash into the lookup box (or open `…/proof/?tx=<hash>`) and the page proves it: from the ledger it has just checked, through that ledger's own record of earlier ledgers and, for older ones, a chain of parent hashes, down to the transaction and its result in its ledger's transaction tree. Nothing on the way is trusted; a wrong byte anywhere breaks the chain. It works back to the start of the ledger's history in 2013, using a public full-history server for anything older than the local node keeps.

**Download the receipt (PDF)** gives you a receipt with the evidence attached inside the PDF. Drop it back on the page, now or years from now, and every check runs again, with nothing else needed. Memos on the transaction are shown, and proven, as part of it.

A receipt comes in two looks. **Deep field**, the default, is drawn like the page: the gate, its lights lit for the validators that signed, the horizon open, and the transaction as a body deep in the horizon's well, in its type's color, smaller the further back its ledger is, and unlit if it failed. Below that is the proof's chain, back from the ledger signed now. Every mark on it is a proven fact, shown once, and its words are real text laid invisibly under the picture, so they can be selected, copied and searched. **Engraved** is the banknote-style certificate this page first printed. `?style=engraved` opens the page with that look chosen.

## What it trusts

One key: the list publisher's, which you pick on the page. The relay and the peer service below are untrusted. They can withhold data, which shows as dark lights or an account left as an outline, but nothing they send is lit unless it checks out.

## How it is put together

- `proof/` is the page: static files, no build step. `js/scene.js` draws the sky in WebGL 2, in HDR with bloom and ACES tone mapping, in Deep Field's own terms: its gate, its event horizon, its validator flares and its transaction colors. `js/app.js` runs the page: it takes raw bytes from the relay, has the worker check them, and tells the scene what passed. There is a guided tour with narration (`js/tour.js`), and layouts for phones held either way. `test/sky.html` shows the scene alone, with made-up events.
- `feed/proof_feed.py` is the relay. It subscribes to a local xrpld's ledger and validation streams and forwards the raw bytes over WebSocket. It also serves the two signed lists, the validators' manifests, the relay's own reading of an account (the outline), and state-tree paths from the peer service.
- `feed/proof_peer.mjs` joins the local xrpld as a peer, over the XRPL peer protocol, and asks for the state-tree nodes along an account's path: the same request nodes use to sync. Lookups for one ledger go out as one request and are cached.
- `proof/js/receipt.js` and `pdf.js` gather a receipt's evidence and write the PDF (by hand, no library) with the evidence attached; `receipt-space.js` draws the Deep Field receipt and `receipt-art.js` the engraved one. `verifyReceipt` in `verify.js` is the one check that both makes and later accepts a receipt.
- `narration/` holds the tour's narration scripts and the script that renders them with [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M). The rendered clips are in `proof/audio/`.

## Running it

You need an xrpld (rippled) node with admin JSON-RPC on `127.0.0.1:5005` and WebSocket on `127.0.0.1:6006`, Python 3.10+ with `websockets` 13 or later, and Node 18+.

1. `python3 feed/proof_feed.py` serves the relay on `127.0.0.1:3783`.
2. `node feed/proof_peer.mjs` serves state paths on `127.0.0.1:3784`. On its first run it creates a node key in `~/.proof-peer.key` and prints the public key. If your node's inbound peer slots are full, reserve one for that key with the admin method `peer_reservations_add`.
3. Serve `proof/` as static files, and proxy `/proof-feed` on the same site (HTTP and WebSocket) to `127.0.0.1:3783`. Opened from localhost, the page talks to `127.0.0.1:3783` directly; `?relay=<url>` points it anywhere else. `?notour` skips the tour a first visit would open.

## Tests

In `proof/test/`, `live.mjs` and `balance.mjs` check the verifier against mainnet through your node, including forged signatures, a tampered list and tampered proof nodes, all of which must be refused. `receipt.mjs` proves transactions near and far (back to 2020 through full history) and refuses five forged receipts. `art.mjs` proves six real transactions (in the ledger signed now, recent, from 2020, a failed one, an issued currency and one with memos) and draws both receipt looks for each, through `art.html`.

The others drive the page in headless Chrome (`CHROME=` names the binary): `receipt-ui.mjs` (prove, download, re-check, a tampered PDF), `tour.mjs` (every stop), `phone.mjs` (a phone's layout, drag, pinch and double-tap), `voice.mjs` (the narrator), `flash.mjs` (no flash between ledgers), `account.mjs` (an account goes from outline to lit, or is proven missing), `outline.mjs` (a proof made to fail leaves the account an outline) and `shot.mjs` (screenshots). They render in software, which is heavy: run them on a machine other than the node's.

## Credits

- Newsreader, by the Newsreader Project Authors, and Geist Mono, by the Geist Project Authors: SIL Open Font License 1.1, in `proof/assets/fonts/OFL-newsreader.txt` and `OFL-geistmono.txt`.
- Bodoni Moda, by the Bodoni Moda Project Authors, for the engraved receipt: SIL Open Font License 1.1, in `proof/assets/fonts/OFL.txt`.
- @noble/curves and @noble/hashes, by Paul Miller: MIT, in `proof/vendor/noble/*/LICENSE`.
- The narration voices af_heart and am_fenrir, from Kokoro-82M by hexgrad: Apache-2.0.

## License

MIT, copyright James Turner. If you use this code, keep its copyright notice, which credits James Turner and links back to this repository: https://github.com/ilubxrp589/xrpl-proof.

A receipt is proof of a transaction only: not currency, and of no monetary value.
