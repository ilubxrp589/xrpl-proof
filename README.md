# Proof

A live certificate for the XRP Ledger, checked by the browser that displays it.

Every few seconds the XRP Ledger's validators agree on a new ledger and sign it. This page takes nobody's word for it. In your browser it checks the validator list against one publisher key, every validator's signature, the quorum and the ledger header, then prints an engraved certificate of what passed. Look up an account and its balance is proven too, hashed node by node up to the state root the validators signed.

**Live:** https://v2v.halcyon-names.io/proof/

Ink means checked here. Pencil means someone else said so.

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

## What it trusts

One key: the list publisher's, which you pick on the page. The relay and the peer service below are untrusted. They can withhold data, which shows as missing signatures or a balance left in pencil, but nothing they send is inked unless it checks out.

## How it is put together

- `proof/` is the page: static files, no build step. A WebGL 2 renderer engraves the certificate, a temple whose 35 columns ink as their validators' signatures check out. It has a guided tour with narration, and layouts for phones held either way.
- `feed/proof_feed.py` is the relay. It subscribes to a local xrpld's ledger and validation streams and forwards the raw bytes over WebSocket. It also serves the two signed lists, the validators' manifests, the relay's own reading of an account (the pencil), and state-tree paths from the peer service.
- `feed/proof_peer.mjs` joins the local xrpld as a peer, over the XRPL peer protocol, and asks for the state-tree nodes along an account's path: the same request nodes use to sync. Lookups for one ledger go out as one request and are cached.
- `narration/` holds the tour's narration scripts and the script that renders them with [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M). The rendered clips are in `proof/audio/`.

## Running it

You need an xrpld (rippled) node with admin JSON-RPC on `127.0.0.1:5005` and WebSocket on `127.0.0.1:6006`, Python 3.10+ with `websockets` 13 or later, and Node 18+.

1. `python3 feed/proof_feed.py` serves the relay on `127.0.0.1:3783`.
2. `node feed/proof_peer.mjs` serves state paths on `127.0.0.1:3784`. On its first run it creates a node key in `~/.proof-peer.key` and prints the public key. If your node's inbound peer slots are full, reserve one for that key with the admin method `peer_reservations_add`.
3. Serve `proof/` as static files, and proxy `/proof-feed` on the same site (HTTP and WebSocket) to `127.0.0.1:3783`. Opened from localhost, the page talks to `127.0.0.1:3783` directly; `?relay=<url>` points it anywhere else.

## Tests

In `proof/test/`, `live.mjs` and `balance.mjs` check the verifier against mainnet through your node, including forged signatures, a tampered list and tampered proof nodes, all of which must be refused. The others drive the page in headless Chrome: `tour.mjs`, `phone.mjs`, `voice.mjs`, `account.mjs`, `pencil.mjs`, `flat.mjs` and `shot.mjs`.

## Credits

- Bodoni Moda, by the Bodoni Moda Project Authors: SIL Open Font License 1.1, in `proof/assets/fonts/OFL.txt`.
- @noble/curves and @noble/hashes, by Paul Miller: MIT, in `proof/vendor/noble/*/LICENSE`.
- The narration voices af_heart and am_fenrir, from Kokoro-82M by hexgrad: Apache-2.0.

## License

MIT. The certificate is proof of ledger state only: not currency, and of no monetary value.
