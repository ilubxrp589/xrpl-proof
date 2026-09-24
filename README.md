# Proof

A live certificate for the XRP Ledger, checked by the browser that displays it.

Every few seconds the XRP Ledger's validators agree on a new ledger and sign it. This page takes nobody's word for it. In your browser it checks the validator list against one publisher key, every validator's signature, the quorum and the ledger header, then prints an engraved certificate of what passed. Look up an account and its balance is proven too, hashed node by node up to the state root the validators signed.

**Live:** https://v2v.halcyon-names.io/proof/

Ink means checked here. Pencil means someone else said so.

## Night and day

The page opens at night, and the certificate is a star atlas plate: silver ink on dark stock flecked with metal. The temple is an observatory, its dome open and its telescope trained on a star. Around it the sky is engraved: stars in three sizes, the Milky Way in stipple, the Plough and Cassiopeia. The moon's phases sit in the corners, and a star chart's declination circles and hour lines are printed underneath. When the ledger's header checks out, the star the telescope watches sends out its rays. `?theme=day` opens the original look instead: cream paper, a temple, green leather.

At night the sheet lies on a desk that is meant to look real. The wood and the leather are photographed textures. Two brass instruments stand beside the sheet, each on a stand of its own: a spyglass on a pillar-and-claw stand, and an astrolabe hanging by its ring from a gallows stand on a mahogany plinth, with a chain wound down the post and coiled round its foot. The lamp that follows your pointer lights them, and they cast shadows. The astrolabe was modelled in Blender (`desk/astrolabe.py`). Its detailed model is rendered face-on as maps of colour, normal and roughness, and a light version of the same parts is drawn in 3D wearing them, so its rims and walls are solid. The spyglass, the stands and the chains are built in `proof/js/props.js`. Phones, which don't show the desk beside the sheet, load none of it.

## What your browser checks

| Step | Check |
|---|---|
| The key | The validator list must be signed by a publisher key built into the page: `vl.ripple.com` (`ED2677AB…`) or `unl.xrplf.org` (`ED42AEC5…`), the two keys a stock node trusts. You choose which. |
| The list | The list's signature and expiry, and every validator's manifest: each master key vouching for the key it signs with today. |
| The signatures | Each validation's secp256k1 signature, over exactly the bytes the validator signed. Partial validations don't count. |
| The quorum | At least 80% of the listed validators (28 of 35 today) must sign the same ledger hash. |
| The ledger | The ledger header must hash (SHA-512Half with the `LWR\0` prefix) to exactly the hash they signed. The state root comes from that header. |
| An account | The nodes from that state root down to the account's entry, in rippled's own wire format, each one hashed and checked. An account that doesn't exist is proven missing. |

All of it runs in a Web Worker, using [@noble/curves](https://github.com/paulmillr/noble-curves) and [@noble/hashes](https://github.com/paulmillr/noble-hashes), vendored in `proof/vendor/`.

## Receipts for any transaction

Paste a transaction hash into the lookup box (or open `…/proof/?tx=<hash>`) and the page proves it: from the ledger it has just checked, through that ledger's own record of earlier ledgers and, for older ones, a chain of parent hashes, down to the transaction and its result in its ledger's transaction tree. Nothing on the way is trusted; a wrong byte anywhere breaks the chain. It works back to the start of the ledger's history in 2013, using a public full-history server for anything older than the local node keeps.

**Download the receipt (PDF)** gives you a receipt with the evidence attached inside the PDF. Drop it back on the page, now or years from now, and every check runs again, with nothing else needed. Memos on the transaction are shown, and proven, as part of it.

A receipt comes in two looks. **Engraved** matches the certificate. **Deep field** is drawn in the terms of Deep Field, this site's live view of consensus. It shows the validators' gate, one flare for each listed validator, lit if it signed. The event horizon inside the gate is open, since it opens only at a quorum. The transaction is a body deep in the horizon's well, in its type's color, smaller the further back its ledger is, and unlit if it failed. Below that is the proof's chain, back from the ledger signed now. Every mark on it is a proven fact, shown once. Its words are real text laid invisibly under the picture, so they can be selected, copied and searched. `?style=space` opens the page with that look chosen.

## What it trusts

One key: the list publisher's, which you pick on the page. The relay and the peer service below are untrusted. They can withhold data, which shows as missing signatures or a balance left in pencil, but nothing they send is inked unless it checks out.

## How it is put together

- `proof/` is the page: static files, no build step. A WebGL 2 renderer engraves the certificate, a temple whose 35 columns ink as their validators' signatures check out. It has a guided tour with narration, and layouts for phones held either way.
- `feed/proof_feed.py` is the relay. It subscribes to a local xrpld's ledger and validation streams and forwards the raw bytes over WebSocket. It also serves the two signed lists, the validators' manifests, the relay's own reading of an account (the pencil), and state-tree paths from the peer service.
- `feed/proof_peer.mjs` joins the local xrpld as a peer, over the XRPL peer protocol, and asks for the state-tree nodes along an account's path: the same request nodes use to sync. Lookups for one ledger go out as one request and are cached.
- `proof/js/receipt.js` and `pdf.js` gather a receipt's evidence and write the PDF (by hand, no library) with the evidence attached; `receipt-art.js` draws the engraved receipt and `receipt-space.js` the Deep Field one. `verifyReceipt` in `verify.js` is the one check that both makes and later accepts a receipt.
- `narration/` holds the tour's narration scripts and the script that renders them with [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M). `scripts-night.json` has the night look's words for the stops that change. The rendered clips are in `proof/audio/`.
- `desk/` holds the night desk's sources: `astrolabe.py` builds and renders the astrolabe in Blender, and `pack.py` packs its maps, and the photographed wood and leather, into `proof/assets/desk/`.

## Running it

You need an xrpld (rippled) node with admin JSON-RPC on `127.0.0.1:5005` and WebSocket on `127.0.0.1:6006`, Python 3.10+ with `websockets` 13 or later, and Node 18+.

1. `python3 feed/proof_feed.py` serves the relay on `127.0.0.1:3783`.
2. `node feed/proof_peer.mjs` serves state paths on `127.0.0.1:3784`. On its first run it creates a node key in `~/.proof-peer.key` and prints the public key. If your node's inbound peer slots are full, reserve one for that key with the admin method `peer_reservations_add`.
3. Serve `proof/` as static files, and proxy `/proof-feed` on the same site (HTTP and WebSocket) to `127.0.0.1:3783`. Opened from localhost, the page talks to `127.0.0.1:3783` directly; `?relay=<url>` points it anywhere else.

## Tests

In `proof/test/`, `live.mjs` and `balance.mjs` check the verifier against mainnet through your node, including forged signatures, a tampered list and tampered proof nodes, all of which must be refused. `receipt.mjs` proves transactions near and far (back to 2020 through full history) and refuses five forged receipts. `art.mjs` proves six real transactions (in the ledger signed now, recent, from 2020, a failed one, an issued currency and one with memos) and draws both receipt looks for each, through `art.html`. The others drive the page in headless Chrome: `receipt-ui.mjs` (prove, download, re-check, a tampered PDF), `tour.mjs`, `phone.mjs`, `voice.mjs`, `flash.mjs`, `account.mjs`, `pencil.mjs`, `flat.mjs` and `shot.mjs`.

## Credits

- Bodoni Moda, by the Bodoni Moda Project Authors: SIL Open Font License 1.1, in `proof/assets/fonts/OFL.txt`.
- Newsreader, by the Newsreader Project Authors, and Geist Mono, by the Geist Project Authors: SIL Open Font License 1.1, in `proof/assets/fonts/OFL-newsreader.txt` and `OFL-geistmono.txt`.
- @noble/curves and @noble/hashes, by Paul Miller: MIT, in `proof/vendor/noble/*/LICENSE`.
- The narration voices af_heart and am_fenrir, from Kokoro-82M by hexgrad: Apache-2.0.
- Wood Table 001, photographed by Dimitrios Savva and processed by Rico Cilliers, and Leather Red 03, by Rob Tuytel, both from [Poly Haven](https://polyhaven.com): CC0, repacked in `proof/assets/desk/`.

## License

MIT, copyright James Turner. If you use this code, keep its copyright notice, which credits James Turner and links back to this repository: https://github.com/ilubxrp589/xrpl-proof.

The certificate is proof of ledger state only: not currency, and of no monetary value.
