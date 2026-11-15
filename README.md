# bsc-mint-guard

A read-only pre-flight guard for BNB Chain (BSC, chain 56) mint contracts.
Give it a project URL or a contract address; it identifies the mint contract
and method, reads the price, quota and open status on-chain, flags risks, and
proves "free" with a value-0 `eth_call` simulation — before anyone signs
anything.

**It never signs, never approves, never pays.** Every check is an `eth_call`,
`eth_getCode`, or `eth_getStorageAt` against the public BSC RPC, plus a
Sourcify verification lookup.

Built as an entry for the [zkVerify Agent Games](https://agentgames.zkverify.io/)
Wildcard track (Season 01, 21 Oct – 21 Nov 2026). The agent is real and
working: it has evaluated 39 mint projects on BSC mainnet since 28 Oct 2026
(see [Track record](#track-record)).

## The problem

Free-mint season on BSC moves fast and lies often:

- Sites label a mint "free" while the contract charges a protocol fee
  (Celiuz: value-0 sim reverted `Insufficient protocol fee`).
- Frontends show "closed" while the contract is open and nearly sold out
  (NULLSECTOR).
- Free phases exhaust in minutes — ShaLingGou and YYDS sold out their free
  quotas ~3 minutes after opening; DINK sold out 5,000 lots in ~86 seconds.
- Pasted "claim" prompts point at unverified contracts ($NOMIO: refused —
  official site states "No token. Nothing more is promised").

The chain is the source of truth. This tool reads it before you act.

## How it works — 7 stages

Every run executes the same seven stages (each timed, reported in `stages`):

| # | Stage | What it does |
|---|-------|--------------|
| 1 | `resolve-input` | A contract address goes direct. A URL is fetched, `0x…` addresses are extracted, infra addresses (WBNB/USDT/routers/SPACE ID registry) filtered out, candidates ranked by proximity to mint/contract keywords. |
| 2 | `onchain-basics` | `eth_getCode`, codehash (Keccak-256), Sourcify verification status. |
| 3 | `history-match` | Exact address → EIP-1967 proxy implementation → selector fingerprint against `data/projects.json` (39 evaluated projects). A match reuses the known method, but address/price/params are **always** re-verified on-chain. |
| 4 | `method-discovery` | Probes candidate free-mint selectors (`freeMint()`, `mintFree()`, `mint(uint256)`, `claim()`, `openFree()`, `takeGift()`, `mintGratis()`, …). Selectors are **computed** from the signature — never guessed. |
| 5 | `price-quota-status` | Batched views: `mintPrice`/`price`/`mintFee`, `totalMinted`/`totalSupply`/`maxSupply`, `paused`/`mintOpen`/`mintLive`, `balanceOf`/`mintedBy`/`freeAvailable` for the wallet. |
| 6 | `risk-check` | Flags: unverified source, EOA owner (can rug/pause), upgradable proxy, tiny code, `PAUSED`, **`PRICE>0`**. |
| 7 | `simulate` | `eth_call` of the identified mint function with value 0 from the wallet. OK / REVERT + reason. Only a value-0 sim proves "free". |

### Verdicts

| Verdict | Meaning |
|---|---|
| `FREE_CANDIDATE` | Value-0 sim OK, no price > 0, not paused — safe to take to a manual mint preview. |
| `PAID_NOT_FREE` | An on-chain price view is > 0 — research only, do not treat as free. |
| `SOLD_OUT` | Supply exhausted. |
| `CLOSED_PAUSED` | Contract paused. |
| `SIM_REVERT` | Sim reverted (reason shown) — investigate, don't force. |
| `NO_CONTRACT` | No code at the address (EOA or wrong chain). |
| `NEEDS_REVIEW` | Novel + unverified — human/AI review before anything. |
| `ERROR` | Input or transport failure (e.g. no contract found on the page). |

`needsAiReview: true` means: read the project's docs, check the official
channels, verify the contract source — then decide. A clean precheck is **not**
a mint authorization.

## Install & usage

Zero dependencies. Node 18+ (tested on Node 24).

```bash
git clone https://github.com/rafunearlwins/bsc-mint-guard.git
cd bsc-mint-guard
npm test          # keccak vectors + selector cross-checks

# Contract address input
node scripts/precheck.mjs 0x2296367F74b2Ec266CF4667d98501Ae7110f5a58

# URL input (extracts the mint contract from the page)
node scripts/precheck.mjs https://digdown.xyz

# JSON output / save report
node scripts/precheck.mjs <URL|CA> --json --out report.json

# Quota views for your own wallet (default is the zero address)
node scripts/precheck.mjs <URL|CA> --wallet 0xYourAddress
```

No wallet is baked in: `--wallet` defaults to the zero address. On-chain facts
(code, price, supply, pause state, simulation) don't depend on the caller;
pass your address only for `balanceOf`/`mintedBy` quota views.

### HTTP demo server

```bash
node scripts/server.mjs 3000   # or: npm run serve / PORT=3000
```

| Endpoint | Description |
|---|---|
| `GET /health` | Liveness check. |
| `GET /` | Service info + endpoint list. |
| `POST /precheck` | `{ "input": "<URL\|0xCA>", "wallet": "<0x..> (optional)" }` → full verdict JSON. |

```bash
curl -X POST http://localhost:3000/precheck \
  -H 'content-type: application/json' \
  -d '{"input":"0xdEAa9aaec224c7429dA2501b159aaf8D79019Ba3"}'
```

## Example output (real run, 15 Nov 2026)

Pickhash (`0x2296367F…`), a project in the experience database — live read
against BSC mainnet:

```
=== BSC Mint Precheck ===
input   : 0x2296367F74b2Ec266CF4667d98501Ae7110f5a58
wallet  : 0x0000000000000000000000000000000000000000 (quota/balance reads use this address)
target  : 0x2296367f74b2ec266cf4667d98501ae7110f5a58 (direct-CA)
code    : 15845 bytes | sourcify: verified
history : exact -> Pickhash
methods : freeMint() [history-exact]
state   : name=Pickhash | symbol=PICK | totalMinted=2846 | totalSupply=2846 | maxSupply=7777 | price=1000000000000000 | mintOpen=true | mintedBy=0
quota   : 1 free/wallet (first mint); mintedBy 0->1 (history)
risk    : owner-is-EOA (can rug/pause); PRICE>0: price=1000000000000000 wei
sim     : freeMint(): REVERT revert: 0x64a0ae920000000000000000000000000000000000000000000000000000000000000000
verdict : PAID_NOT_FREE
warnings:
  - NOT_FREE: on-chain price view > 0 — do not treat as free mint
  - SIM_FAIL: all value-0 simulations reverted — revert: 0x64a0ae920000000000000000000000000000000000000000000000000000000000000000
timings : 1_resolve_input=0ms 2_onchain_basics=1473ms 3_history_match=0ms 4_method_discovery=0ms 5_price_quota_status=745ms 6_risk_check=117ms 7_simulate=111ms
note    : read-only. No signature, no approval, no payment was made.
```

Note the honest edge case this run shows: Pickhash's generic `price()` view
reads 0.001 BNB, so the verdict is `PAID_NOT_FREE` — yet the contract is
mode-1 "first mint free" (the free mint was actually executed on 14 Nov 2026,
tx `0xf5bc…edf94`, token #1499). The verdict does not yet model first-free
modes; the database entry records the lesson — always read `mintStatus` +
`quote()` for such contracts. See [Limitations](#limitations).

A second live run the same day, Flaggies (`0xdEAa9aae…`), returned
`PAID_NOT_FREE` with `totalSupply = MAX_SUPPLY = 5555` (fully minted),
owner renounced (`0x0`), Sourcify-verified.

## Track record

Real evaluations, 28 Oct – 15 Nov 2026. Every entry in
[`data/projects.json`](data/projects.json) carries the contract, site, mint
method, price, quota, outcome, tx hash and the lesson learned. Contracts, tx
hashes and token IDs are public on-chain records.

| Outcome | Count |
|---|---|
| success | 21 |
| failed (pool exhausted / reverted at execution) | 6 |
| skipped (paid, not live, or no on-chain mint path) | 7 |
| declined (failed the strictly-0 gate) | 1 |
| refused (phishing) | 1 |
| cancelled (sold out before preview) | 1 |
| not-open-yet / paused-at-check | 2 |
| **Total evaluated** | **39** |

Notable cases:

- **NULLSECTOR** (2 Nov) — frontend showed the mint closed; the chain said
  open and nearly sold out. Minted #4173 (`0xf8e6…f52`).
- **Celiuz Cell** (2 Nov) — site said "gas only"; value-0 sim reverted
  `Insufficient protocol fee` (0.00008 BNB). Skipped, nothing spent.
- **$NOMIO claim** (1 Nov) — pasted third-party "claim" prompt pointed at an
  unverified contract; official site disavows any token. **Refused.**
- **DINK Coin** (13 Nov) — mint opened 19:00 WIB and hit 5,000/5,000 in
  ~86 seconds. Cancelled before preview; nothing spent.
- **Koma Agent / JNTM** (12–13 Nov) — free pools (500 / 1,000) exhausted
  during the attempt; the guard reported it instead of forcing a paid mint.
- **Pickhash** (14 Nov) — free-minted #1499 (`0xf5bc…edf94`) after the
  guard's mode-1 first-free finding overruled its own `PAID_NOT_FREE` verdict.
- **HashOre** (29 Oct) — PoW-gated mint; mined block #331, Copper (Rare).

### Data notes

- Selectors are computed from signatures. During cleanup, one recorded
  selector was found wrong (HONGBAO's `openFree()` carried `claimFree()`'s
  `0xf366afc9`) and corrected to the computed `0x1644fa8e`.
- Three early records (AiGentAuto, PANBA, Jinhou BAYC, all 4 Nov 2026) were
  normalized into the array from legacy entries; fields that were never
  recorded are `?`/`null`, not invented.
- The vendored Keccak-256 (`scripts/keccak.mjs`, pure JS, zero deps) is
  cross-checked against @noble/hashes on 11 signatures and covered by
  `npm test`.

## Limitations (known, documented)

- **First-free modes**: a generic `price() > 0` view yields `PAID_NOT_FREE`
  even when the first mint is free (Pickhash). Check `mintStatus`/`quote()`
  for such contracts.
- **JS-rendered pages**: URL input extracts contracts from static HTML only.
  Sites that ship the contract in a JS bundle (e.g. pickhash.art) return
  `ERROR` — paste the contract address instead.
- **Verdict precedence**: `PRICE>0` is reported before `SOLD_OUT`, so a
  sold-out paid mint reports `PAID_NOT_FREE` (Flaggies: 5555/5555).
- **Zero-address sims**: the default zero-address wallet can revert on
  eligibility-gated mints (e.g. Agent-ID-gated `freeMint()`); pass
  `--wallet` for a representative simulation.
- **BSC only** (chain 56). The RPC endpoint is the public
  `bsc-dataseed.bnbchain.org`.

## Verifiability & zkVerify direction

Today the guard's claims are verifiable the old-fashioned way: every verdict
is reproducible — same input, same block, same RPC calls, same output. The
report includes the target address, codehash, Sourcify match, and the exact
revert data, so anyone can re-run it and check.

**No zkVerify integration exists yet** — this is stated explicitly so nobody
has to guess. The checkable-claim direction for future work:

1. **zkTLS for the URL-fetch step**: stage 1 fetches a project page over
   HTTPS and extracts candidate contracts. A zkTLS proof would let the guard
   prove "this address appeared on this official page at this time" without
   revealing the full page — turning a trust-me fetch into a checkable claim.
2. **Proof-backed verdicts**: the stage-7 value-0 simulation result
   (calldata + returndata/revert) could be committed alongside the verdict so
   a third party can verify the guard actually ran the simulation it claims.

Both are future work, not current features.

## Files

```
bsc-mint-guard/
├── scripts/
│   ├── check.mjs      # the 7-stage pipeline (importable: runPrecheck)
│   ├── precheck.mjs   # CLI wrapper (human / --json / --out)
│   ├── server.mjs     # HTTP demo server (stdlib only)
│   ├── lib.mjs        # RPC batching, selectors, decoding, page extraction
│   └── keccak.mjs     # vendored pure-JS Keccak-256
├── data/
│   └── projects.json  # experience database: 39 evaluated projects
├── test/
│   └── keccak.test.mjs
├── package.json       # zero dependencies
└── README.md
```

## License

MIT — see [LICENSE](LICENSE).
