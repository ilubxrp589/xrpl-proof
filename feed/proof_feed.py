#!/usr/bin/env python3
"""
proof-feed — raw material for the Proof Note page (design/proof/).

The page believes NOTHING this relay says. Every byte it forwards is checked
in the visitor's browser against one pinned key, the validator-list
publisher's (see design/proof/js/verify.js). So this relay only has to be
fast and complete; it never has to be trusted. It can withhold — that shows
on the page as missing signatures — but it cannot forge.

Inputs
  * local xrpld WS  ws://127.0.0.1:6006   ledger + validations streams
  * local xrpld RPC http://127.0.0.1:5005 binary ledger headers, manifests,
                                          account_info
  * https://vl.ripple.com, unl.xrplf.org   the two signed lists (neither sends
                                          a CORS header, which is why they are relayed)

Output on :3783 (behind a reverse proxy at /proof-feed on the page's own site)
  WS   {"t":"ledger", seq, hash, header, txns, at}   a ledger closed
       {"t":"val", data, at}                          one raw validation
       on connect: {"t":"hello", ...} then the last few ledgers replayed
  GET  /vl?src=ripple|xrplf  /manifests  /account?addr=r…  /latest  /health
       /path?key=<64 hex>&ledger=<64 hex>[&tree=tx]
                                          the nodes from a ledger's state root
                                          (or transaction root) down to one entry,
                                          fetched by proof-peer (proof_peer.mjs,
                                          :3784) over the peer protocol; the page
                                          hashes them
       /tx?hash=<64 hex>                  a validated transaction, raw, and its ledger
       /header?ledger=<64 hex | number>   a validated ledger's raw header
       /headers?from=<n>&to=<m>           headers n, n-1, … m (at most 256): a walk
                                          back through parent hashes, for receipts
       /ledger-txs?ledger=<n>             every transaction in ledger n, raw, so the
                                          page can rebuild its transaction tree
Older than the local node's history, these come from a public full-history
server (xrplcluster.com, then s2.ripple.com): no more trusted than the node.
Paths match on suffix, so the same handler works behind the proxy prefix.
"""
import asyncio, json, os, re, ssl, subprocess, tempfile, time, urllib.error, urllib.request, urllib.parse, http, logging

XRPLD_WS  = "ws://127.0.0.1:6006"
XRPLD_RPC = "http://127.0.0.1:5005/"
# the two publishers a stock node trusts; the page lets the visitor pick one
VL_URLS   = {"ripple": "https://vl.ripple.com", "xrplf": "https://unl.xrplf.org"}
LISTEN    = ("127.0.0.1", int(os.environ.get("PROOF_FEED_PORT", "3783")))
KEEP      = 6          # ledgers replayed to a new client so the page starts full
PEER_PATH = "http://127.0.0.1:" + os.environ.get("PROOF_PEER_PORT", "3784") + "/path"
HASHES_KEEP = 40       # proofs are served for this many recent ledgers only
VL_TTL    = 600        # seconds; the list changes every few months

log = logging.getLogger("proof-feed")
import websockets
from websockets.asyncio.server import serve, broadcast as ws_broadcast

CLIENTS = set()
RECENT  = {}   # seq -> {"ledger": frame|None, "vals": [frame]}
TIP     = {"seq": 0, "at": 0}   # newest ledger closed, and when the relay saw it (ms)
HASHES  = {}   # ledger hash -> seq, the recent ones a proof may be asked for
# receipts read older ledgers (the node's disk, or a public server): a few requests a second, whoever asks
BUCKET  = {"tokens": 20.0, "at": 0.0}
FULL_HISTORY = ["https://xrplcluster.com/", "https://s2.ripple.com:51234/"]
HEADERS = {}   # seq -> (hash, header hex): a validated ledger's header never changes
HEX64   = re.compile(r"^[0-9A-F]{64}$")
CACHE   = {"manifests": (0, None)}


def rpc(method, params=None, timeout=8):
    body = json.dumps({"method": method, "params": [params or {}]}).encode()
    req = urllib.request.Request(XRPLD_RPC, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r).get("result", {})


def now_ms():
    return int(time.time() * 1000)


# ── the list and its validators' manifests ───────────────────────────────────
TLS = {}   # host -> a TLS context that also holds the intermediate that host forgot to send


def complete_chain(host):
    """Some sites stop sending their intermediate certificate (vl.ripple.com
    did on 2026-09-23: its leaf twice, no Amazon RSA 2048 M04). Browsers fetch
    the missing one from the address the leaf names (its AIA "CA Issuers" URL);
    urllib does not. Do the same, but trust what comes back only once openssl
    has verified it against this machine's own roots: the download is plain
    http, so it must never be allowed to become a root itself."""
    pem = ssl.get_server_certificate((host, 443), timeout=10)      # read only for its AIA
    ctx, added = ssl.create_default_context(), 0
    with tempfile.TemporaryDirectory() as d:
        leaf = os.path.join(d, "leaf.pem")
        with open(leaf, "w") as f:
            f.write(pem)
        for url in ssl._ssl._test_decode_cert(leaf).get("caIssuers", ()):
            if not url.startswith("http"):
                continue
            der = urllib.request.urlopen(url, timeout=10).read()
            ca = os.path.join(d, "issuer.pem")
            with open(ca, "w") as f:
                f.write(der.decode() if der.startswith(b"-----") else ssl.DER_cert_to_PEM_cert(der))
            if subprocess.run(["openssl", "verify", ca], capture_output=True).returncode == 0:
                ctx.load_verify_locations(cafile=ca)
                added += 1
    if not added:
        raise ssl.SSLError(f"{host}: no intermediate that verifies against the system roots")
    TLS[host] = ctx
    log.warning("%s sends an incomplete certificate chain; completed it from its AIA issuer", host)
    return ctx


def get_vl(src="ripple"):
    src = src if src in VL_URLS else "ripple"
    t, body = CACHE.get("vl:" + src, (0, None))
    if body is None or time.time() - t > VL_TTL:
        url = VL_URLS[src]
        host = urllib.parse.urlsplit(url).hostname
        req = urllib.request.Request(url, headers={"User-Agent": "proof-feed/1"})
        try:
            try:
                with urllib.request.urlopen(req, timeout=10, context=TLS.get(host)) as r:
                    fresh = r.read().decode()
            except urllib.error.URLError as e:
                if not isinstance(e.reason, ssl.SSLCertVerificationError):
                    raise
                with urllib.request.urlopen(req, timeout=10, context=complete_chain(host)) as r:
                    fresh = r.read().decode()
            body = fresh
            CACHE["vl:" + src] = (time.time(), body)
        except Exception as e:
            # the list is signed, and the page checks its signature and expiry
            # itself: the last good copy is safe to hand out while the site is down
            if body is None:
                raise
            log.warning("list refresh from %s failed (%s); serving the copy from %ds ago", host, e, time.time() - t)
    return body


def get_manifests():
    """The newest manifest our node knows for each listed master key. The list
    carries a manifest per validator too, but a validator that rotated its
    signing key since the list was published needs the newer one. Unverified
    here; the browser checks each against the master key the list names."""
    t, out = CACHE["manifests"]
    if out is None or time.time() - t > VL_TTL:
        import base64
        masters = []
        for src in VL_URLS:
            try:
                doc = json.loads(base64.b64decode(json.loads(get_vl(src))["blob"]))
                masters += [v["validation_public_key"] for v in doc.get("validators", [])]
            except Exception as e:
                log.warning("list %s unavailable: %s", src, e)
        out = []
        for key in dict.fromkeys(masters):
            v = {"validation_public_key": key}
            try:
                r = rpc("manifest", {"public_key": node_key(v["validation_public_key"])})
                if r.get("manifest"):
                    out.append(r["manifest"])
            except Exception as e:
                log.warning("manifest fetch failed: %s", e)
        CACHE["manifests"] = (time.time(), out)
    return out


B58 = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz"


def node_key(hex_key):
    """33-byte key hex -> n…/nH… token (type 0x1C, double-SHA256 checksum)."""
    import hashlib
    body = bytes([0x1C]) + bytes.fromhex(hex_key)
    raw = body + hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]
    n = int.from_bytes(raw, "big")
    s = ""
    while n:
        n, r = divmod(n, 58)
        s = B58[r] + s
    return s


def account(addr):
    r = rpc("account_info", {"account": addr, "ledger_index": "validated"})
    if r.get("error"):
        return {"error": r.get("error_message") or r.get("error")}
    d = r.get("account_data", {})
    return {"account": d.get("Account"), "balance": d.get("Balance"),
            "index": d.get("index"), "ledger": r.get("ledger_index"),
            "note": "the relay's reading; the page proves balances itself, from /path"}


def spend():
    now = time.time()
    BUCKET["tokens"] = min(20.0, BUCKET["tokens"] + (now - BUCKET["at"]) * 4.0)
    BUCKET["at"] = now
    if BUCKET["tokens"] < 1:
        return False
    BUCKET["tokens"] -= 1
    return True


def remote(method, params):
    """A public full-history server, for what the local node no longer has."""
    last = {"error": "no full-history server answered"}
    for url in FULL_HISTORY:
        try:
            req = urllib.request.Request(url, json.dumps({"method": method, "params": [params]}).encode(),
                                         {"Content-Type": "application/json", "User-Agent": "proof-feed/1"})
            with urllib.request.urlopen(req, timeout=20) as r:
                res = json.load(r).get("result", {})
            if res.get("error") in ("tooBusy", "slowDown", "noNetwork", "noCurrent", "noClosed"):
                last = res
                continue
            return res
        except Exception as e:
            last = {"error": str(e)}
    return last


def either(method, params):
    """The local node first; what it lacks, from full history. Untrusted either way."""
    r = rpc(method, params)
    if r.get("error") in ("txnNotFound", "lgrNotFound", "notFound", "lgrIdxsInvalid") or \
            (method == "ledger" and not r.get("error") and not r.get("ledger")):
        r = remote(method, params)
    return r


def header_at(seq):
    if seq not in HEADERS:
        r = either("ledger", {"ledger_index": seq, "binary": True})
        if r.get("error") or not r.get("ledger") or not r.get("validated"):
            raise LookupError(f"ledger {seq:,} is not available")
        HEADERS[seq] = (r["ledger_hash"], r["ledger"]["ledger_data"])
        while len(HEADERS) > 50000:
            del HEADERS[next(iter(HEADERS))]
    return HEADERS[seq]


def get_headers(frm, to):
    if not (0 < to <= frm and frm - to < 256):
        return {"error": "ask for at most 256 consecutive ledgers, newest first"}
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(6) as pool:
        got = list(pool.map(lambda n: header_at(n), range(frm, to - 1, -1)))
    return {"from": frm, "to": to, "hashes": [h for h, _ in got], "headers": [d for _, d in got]}


def get_ledger_txs(seq):
    r = either("ledger", {"ledger_index": seq, "transactions": True, "expand": True, "binary": True})
    if r.get("error") or not r.get("ledger") or not r.get("validated"):
        return {"error": f"ledger {seq:,} is not available"}
    txs = [{"tx_blob": t["tx_blob"], "meta": t.get("meta") or t.get("meta_blob")} for t in r["ledger"].get("transactions", [])]
    return {"ledger": seq, "hash": r["ledger_hash"], "transactions": txs}


def get_tx(txhash):
    """A validated transaction, raw, with the hash and number of its ledger.
    Untrusted like everything here: the page proves all of it."""
    r = either("tx", {"transaction": txhash, "binary": True, "api_version": 2})
    if r.get("error"):
        return {"error": "no record of that transaction, here or in full history. Check the hash."}
    if not r.get("validated") or not r.get("ledger_hash"):
        return {"error": "that transaction is not in a validated ledger yet."}
    return {"hash": r["hash"], "ledger_hash": r["ledger_hash"], "ledger_index": r["ledger_index"],
            "tx_blob": r["tx_blob"], "meta_blob": r["meta_blob"], "close_time_iso": r.get("close_time_iso")}


def get_header(ledger):
    if not HEX64.match(ledger):
        try:
            h, d = header_at(int(ledger))
        except LookupError as e:
            return {"error": str(e)}
        return {"hash": h, "seq": int(ledger), "header": d}
    r = either("ledger", {"ledger_hash": ledger, "binary": True})
    if r.get("error") or not r.get("ledger") or not r.get("validated"):
        return {"error": "that ledger is not available."}
    return {"hash": r["ledger_hash"], "seq": r["ledger_index"], "header": r["ledger"]["ledger_data"]}


def peer_path(key, ledger, tree="state"):
    """Relay proof-peer's answer (or its error) unchanged: the page checks it."""
    q = urllib.parse.urlencode({"key": key, "ledger": ledger, "tree": tree})
    try:
        with urllib.request.urlopen(f"{PEER_PATH}?{q}", timeout=9) as r:
            return http.HTTPStatus.OK, r.read().decode()
    except urllib.error.HTTPError as e:
        return http.HTTPStatus.BAD_GATEWAY, e.read().decode()
    except Exception as e:
        return http.HTTPStatus.BAD_GATEWAY, json.dumps({"error": f"the proof service is down ({e})"})


# ── the stream ───────────────────────────────────────────────────────────────
def slot(seq):
    b = RECENT.get(seq)
    if b is None:
        b = RECENT[seq] = {"ledger": None, "vals": []}
        while len(RECENT) > KEEP + 2:
            del RECENT[min(RECENT)]
    return b


async def broadcast(frame):
    # never wait on a visitor: a slow page must not stall the reader, or xrpld
    # drops the relay as a slow subscriber. Clients that fall behind are skipped.
    ws_broadcast(CLIENTS, json.dumps(frame, separators=(",", ":")))


async def on_ledger(m):
    seq, h = int(m["ledger_index"]), m["ledger_hash"]
    at = now_ms()
    if seq > TIP["seq"]:
        TIP["seq"], TIP["at"] = seq, at
    HASHES[h.upper()] = seq
    while len(HASHES) > HASHES_KEEP:
        del HASHES[next(iter(HASHES))]
    try:
        r = await asyncio.to_thread(rpc, "ledger", {"ledger_hash": h, "binary": True})
        header = (r.get("ledger") or {}).get("ledger_data")
    except Exception as e:
        log.warning("header fetch for %s failed: %s", seq, e)
        header = None
    frame = {"t": "ledger", "seq": seq, "hash": h, "header": header,
             "txns": m.get("txn_count"), "close": m.get("ledger_time"), "at": at}
    slot(seq)["ledger"] = frame
    await broadcast(frame)


async def on_validation(m):
    try:
        seq = int(m.get("ledger_index"))
    except (TypeError, ValueError):
        return
    # other networks' validators reach this node too; keep mainnet's window
    if not TIP["seq"] or abs(seq - TIP["seq"]) > 20:
        return
    if not m.get("data"):
        return
    frame = {"t": "val", "seq": seq, "data": m["data"], "at": now_ms()}
    slot(seq)["vals"].append(frame)
    await broadcast(frame)


async def chain_reader():
    while True:
        try:
            async with websockets.connect(XRPLD_WS, ping_interval=20, max_size=16_000_000) as ws:
                await ws.send(json.dumps({"id": 1, "command": "subscribe",
                                          "streams": ["ledger", "validations"]}))
                log.info("subscribed to xrpld")
                async for raw in ws:
                    m = json.loads(raw)
                    ty = m.get("type")
                    if ty == "ledgerClosed":
                        asyncio.create_task(on_ledger(m))
                    elif ty == "validationReceived":
                        await on_validation(m)
        except Exception as e:
            log.warning("chain reader dropped (%s), reconnecting in 3s", e)
            await asyncio.sleep(3)


# ── server ───────────────────────────────────────────────────────────────────
async def client(ws):
    CLIENTS.add(ws)
    try:
        await ws.send(json.dumps({"t": "hello", "tip": TIP["seq"], "tip_at": TIP["at"], "at": now_ms()}))
        # replay complete ledgers oldest first, so the page opens mid-story
        for seq, b in sorted(RECENT.items()):
            if b["ledger"]:
                await ws.send(json.dumps({**b["ledger"], "replay": True}, separators=(",", ":")))
            for v in b["vals"]:
                await ws.send(json.dumps({**v, "replay": True}, separators=(",", ":")))
        async for _ in ws:
            pass
    except Exception:
        pass
    finally:
        CLIENTS.discard(ws)


def respond(connection, code, body, ctype="application/json"):
    r = connection.respond(code, body)
    r.headers["Content-Type"] = ctype
    r.headers["Cache-Control"] = "no-store"
    # public, signed data that the page verifies anyway; lets a page on
    # another origin (or a local copy) use the relay
    r.headers["Access-Control-Allow-Origin"] = "*"
    return r


async def http_handler(connection, request):
    # every fetch runs in a thread: a slow xrpld or list site must not freeze the
    # event loop that feeds the WebSocket
    url = urllib.parse.urlsplit(request.path)
    path = url.path.rstrip("/") or "/"
    try:
        if path.endswith("/vl"):
            src = (urllib.parse.parse_qs(url.query).get("src") or ["ripple"])[0]
            return respond(connection, http.HTTPStatus.OK, await asyncio.to_thread(get_vl, src))
        if path.endswith("/manifests"):
            ms = await asyncio.to_thread(get_manifests)
            return respond(connection, http.HTTPStatus.OK, json.dumps({"manifests": ms}))
        if path.endswith("/account"):
            addr = (urllib.parse.parse_qs(url.query).get("addr") or [""])[0].strip()
            if not addr.startswith("r") or not 25 <= len(addr) <= 35:
                return respond(connection, http.HTTPStatus.BAD_REQUEST, json.dumps({"error": "not an r-address"}))
            return respond(connection, http.HTTPStatus.OK, json.dumps(await asyncio.to_thread(account, addr)))
        if path.endswith("/path"):
            q = urllib.parse.parse_qs(url.query)
            key = (q.get("key") or [""])[0].upper()
            ledger = (q.get("ledger") or [""])[0].upper()
            if not HEX64.match(key) or not HEX64.match(ledger):
                return respond(connection, http.HTTPStatus.BAD_REQUEST,
                               json.dumps({"error": "key and ledger must be 64 hex characters"}))
            # only ledgers this relay has just seen close: nobody can make the
            # node dig through history, or ask about ledgers it never had
            tree = "tx" if (q.get("tree") or [""])[0] == "tx" else "state"
            # only ledgers this relay has just seen close: nobody can make the
            # node dig through history, or ask about ledgers it never had
            if ledger not in HASHES:
                return respond(connection, http.HTTPStatus.NOT_FOUND,
                               json.dumps({"error": "that is not one of the last few ledgers"}))
            code, body = await asyncio.to_thread(peer_path, key, ledger, tree)
            return respond(connection, code, body)
        if path.endswith("/headers") or path.endswith("/ledger-txs"):
            q = urllib.parse.parse_qs(url.query)
            try:
                a = int((q.get("from") or q.get("ledger") or ["x"])[0]); b = int((q.get("to") or [a])[0])
            except ValueError:
                return respond(connection, http.HTTPStatus.BAD_REQUEST, json.dumps({"error": "ledger numbers, please"}))
            if not spend():
                return respond(connection, http.HTTPStatus.TOO_MANY_REQUESTS, json.dumps({"error": "busy; try again in a moment"}))
            try:
                body = await asyncio.to_thread(get_headers, a, b) if path.endswith("/headers") else await asyncio.to_thread(get_ledger_txs, a)
            except LookupError as e:
                body = {"error": str(e)}
            return respond(connection, http.HTTPStatus.OK, json.dumps(body))
        if path.endswith("/tx") or path.endswith("/header"):
            q = urllib.parse.parse_qs(url.query)
            arg = (q.get("hash") or q.get("ledger") or [""])[0].strip().upper()
            if not (HEX64.match(arg) or (path.endswith("/header") and arg.isdigit())):
                return respond(connection, http.HTTPStatus.BAD_REQUEST,
                               json.dumps({"error": "that is not a 64-character hash"}))
            if not spend():
                return respond(connection, http.HTTPStatus.TOO_MANY_REQUESTS,
                               json.dumps({"error": "busy; try again in a moment"}))
            fn = get_tx if path.endswith("/tx") else get_header
            return respond(connection, http.HTTPStatus.OK, json.dumps(await asyncio.to_thread(fn, arg)))
        if path.endswith("/latest") or path.endswith("/health"):
            last = RECENT[max(RECENT)] if RECENT else None
            body = {"clients": len(CLIENTS), "tip": TIP["seq"],
                    "tip_age_s": round((now_ms() - TIP["at"]) / 1000, 1) if TIP["at"] else None,
                    "held": sorted(RECENT), "last_vals": len(last["vals"]) if last else 0}
            return respond(connection, http.HTTPStatus.OK, json.dumps(body, indent=1) + "\n")
    except Exception as e:
        log.warning("http %s failed: %s", path, e)
        return respond(connection, http.HTTPStatus.BAD_GATEWAY, json.dumps({"error": str(e)}))
    return None


async def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        datefmt="%H:%M:%S")
    asyncio.create_task(chain_reader())
    # warm the list and manifest caches so the first visitor does not wait on them
    asyncio.create_task(asyncio.to_thread(get_manifests))
    async with serve(client, LISTEN[0], LISTEN[1], process_request=http_handler,
                     max_size=2**16):
        log.info("proof-feed listening on ws://%s:%d", *LISTEN)
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
