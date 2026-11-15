// bsc-mint-guard core pipeline: URL-or-CA -> mint contract identification,
// price, quota, status, risk check, value-0 simulation.
// Read-only. Never signs, never pays, never sends a transaction.
// Exported as runPrecheck() so both the CLI and the HTTP demo server use it.
//
// The 7 stages (each timed, printed in `stages`):
//   1 resolve-input      CA goes direct; URL is fetched and 0x addresses are
//                        extracted, infra addresses filtered, candidates ranked
//                        by proximity to mint/contract keywords.
//   2 onchain-basics    eth_getCode, codehash, Sourcify verification status.
//   3 history-match     exact address -> EIP-1967 proxy implementation ->
//                        selector fingerprint against data/projects.json.
//                        A match reuses the known method, but address/price/
//                        params are ALWAYS re-verified on-chain.
//   4 method-discovery  probes candidate free-mint selectors (freeMint(),
//                        mintFree(), mint(uint256), claim(), openFree(),
//                        takeGift(), mintGratis(), ...). Selectors are
//                        COMPUTED from the signature — never guessed.
//   5 price-quota-status batched views: mintPrice/price/mintFee,
//                        totalMinted/totalSupply/maxSupply,
//                        paused/mintOpen/mintLive, balanceOf/mintedBy/
//                        freeAvailable for the wallet.
//   6 risk-check        flags: unverified source, EOA owner (can rug/pause),
//                        upgradable proxy, tiny code, PAUSED, PRICE>0.
//   7 simulate          eth_call of the identified mint fn with value 0 from
//                        the wallet. OK / REVERT + reason.
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  sel, padAddr, padUint, codehash, EIP1967_SLOT,
  decUint, decBool, decAddr, decString,
  batchCalls, ethGetCode, ethGetStorageAt, sourcifyStatus, extractContracts,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');

// No personal wallet is baked in. The zero address is the default: on-chain
// facts (code, price, supply, pause state, simulation) do not depend on the
// caller, and quota views (balanceOf / mintedBy) simply read empty. Pass
// --wallet <your address> (CLI) or "wallet" (API) for quota views.
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const DEFAULT_WALLET = ZERO_ADDRESS;

// ---------- candidate mint probes (sig -> arg builder) ----------
const MINT_PROBES = [
  ['freeMint()', () => ''],
  ['mintFree()', () => ''],
  ['mint()', () => ''],
  ['claim()', () => ''],
  ['claimFree()', () => ''],
  ['openFree()', () => ''],
  ['takeGift()', () => ''],
  ['mintGratis()', () => ''],
  ['mint(uint256)', () => padUint(1)],
  ['mint(uint256)', () => padUint(2)],
  ['freeMint(uint256)', () => padUint(1)],
  ['mintFree(uint256)', () => padUint(1)],
  ['claimFree(uint256)', () => padUint(1)],
];
// ---------- view probes: label -> [sig, argBuilder, decoder] ----------
// NOTE: arg builders close over the run's wallet (see runPrecheck).
function viewProbes(wallet) {
  return [
    ['name', 'name()', () => '', v => decString(v)],
    ['symbol', 'symbol()', () => '', v => decString(v)],
    ['owner', 'owner()', () => '', v => decAddr(v)],
    ['totalMinted', 'totalMinted()', () => '', v => decUint(v)?.toString()],
    ['totalSupply', 'totalSupply()', () => '', v => decUint(v)?.toString()],
    ['maxSupply', 'maxSupply()', () => '', v => decUint(v)?.toString()],
    ['MAX_SUPPLY', 'MAX_SUPPLY()', () => '', v => decUint(v)?.toString()],
    ['mintPrice', 'mintPrice()', () => '', v => decUint(v)?.toString()],
    ['price', 'price()', () => '', v => decUint(v)?.toString()],
    ['mintFee', 'mintFee()', () => '', v => decUint(v)?.toString()],
    ['paused', 'paused()', () => '', v => decBool(v)],
    ['mintOpen', 'mintOpen()', () => '', v => decBool(v)],
    ['mintLive', 'mintLive()', () => '', v => decBool(v)],
    ['saleActive', 'saleActive()', () => '', v => decBool(v)],
    ['balanceOf', 'balanceOf(address)', () => padAddr(wallet), v => decUint(v)?.toString()],
    ['mintedBy', 'mintedBy(address)', () => padAddr(wallet), v => decUint(v)?.toString()],
    ['minted', 'minted(address)', () => padAddr(wallet), v => decUint(v)?.toString()],
    ['freeAvailable', 'freeAvailable(address)', () => padAddr(wallet), v => decUint(v)?.toString()],
    ['freeClaimed', 'freeClaimed(address)', () => padAddr(wallet), v => decBool(v) ?? decUint(v)?.toString()],
    ['hasClaimed', 'hasClaimed(address)', () => padAddr(wallet), v => decBool(v)],
    ['claimed', 'claimed(address)', () => padAddr(wallet), v => decBool(v)],
    ['freeMinted', 'freeMinted()', () => '', v => decUint(v)?.toString()],
    ['freeUsed', 'freeUsed()', () => '', v => decUint(v)?.toString()],
  ];
}

function loadProjects() {
  return JSON.parse(readFileSync(join(DATA, 'projects.json'), 'utf8')).projects;
}

/**
 * Run the full 7-stage precheck. Returns a report object:
 *   { input, wallet, target, basics, history, methods, state, risk, sim,
 *     verdict, warnings, needsAiReview, stages }
 * Verdicts: FREE_CANDIDATE | PAID_NOT_FREE | SOLD_OUT | CLOSED_PAUSED |
 *   SIM_REVERT | NO_CONTRACT | NEEDS_REVIEW | ERROR (input/transport failure)
 */
export async function runPrecheck(input, { wallet = DEFAULT_WALLET } = {}) {
  const timings = {};
  async function stage(name, fn) {
    const t0 = performance.now();
    const r = await fn();
    timings[name] = Math.round(performance.now() - t0);
    return r;
  }
  const finish = (report) => { report.stages = timings; return report; };

  const isCA = /^0x[a-fA-F0-9]{40}$/.test(input);
  const report = { input, wallet, stages: {}, warnings: [], needsAiReview: false };
  const projects = loadProjects();

  // ================= STAGE 1: resolve input =================
  const candidates = await stage('1_resolve_input', async () => {
    if (isCA) return [{ addr: input.toLowerCase(), count: 1, nearMint: true, source: 'direct-CA' }];
    const list = await extractContracts(input);
    report.stages.page = input;
    return list.slice(0, 8).map(c => ({ ...c, source: 'page-extract' }));
  });
  if (!candidates.length) {
    report.error = 'no contract candidates found';
    report.verdict = 'ERROR';
    return finish(report);
  }
  const target = candidates[0].addr;
  report.target = { addr: target, source: candidates[0].source, alternates: candidates.slice(1, 4).map(c => c.addr) };
  // Guard: a wallet equal to the target contract would make balanceOf/mintedBy
  // read the contract itself (always 0) — a false "missing NFT" alarm.
  if (wallet.toLowerCase() === target.toLowerCase()) {
    report.warnings.push('WALLET_IS_TARGET: wallet equals the target contract — balanceOf/mintedBy read the contract itself, not your holdings. Re-run with --wallet <your address>.');
    report.needsAiReview = true;
  }

  // ================= STAGE 2: on-chain basics =================
  const basics = await stage('2_onchain_basics', async () => {
    const code = await ethGetCode(target);
    const sourcify = await sourcifyStatus(target);
    return {
      hasCode: code !== '0x',
      codeBytes: (code.length - 2) / 2,
      codeHash: code === '0x' ? null : codehash(code),
      sourcify,
    };
  });
  report.basics = basics;
  if (!basics.hasCode) {
    report.warnings.push('NO_CODE: address has no contract code (EOA or wrong chain)');
    report.needsAiReview = true;
    report.verdict = 'NO_CONTRACT';
    return finish(report);
  }

  // ================= STAGE 3: history match =================
  const history = await stage('3_history_match', async () => {
    // 3a. exact address
    const exact = projects.find(p => p.contract.toLowerCase() === target.toLowerCase());
    if (exact) return { kind: 'exact', project: exact.name, record: exact };
    // 3b. proxy implementation (EIP-1967 slot)
    const implSlot = await ethGetStorageAt(target, EIP1967_SLOT);
    let impl = null;
    if (implSlot && implSlot !== '0x' + '0'.repeat(64)) {
      impl = decAddr(implSlot);
      const implHit = projects.find(p => p.contract.toLowerCase() === impl.toLowerCase());
      if (implHit) return { kind: 'proxy-impl', project: implHit.name, record: implHit, impl };
    }
    // 3c. selector fingerprint: which known mint sigs exist on this contract
    const probes = MINT_PROBES.map(([sig, ab]) => ({
      to: target, data: sel(sig) + ab(), label: `fp:${sig}`,
    }));
    const res = await batchCalls(probes, { from: wallet });
    const hits = res.filter(r => r.ok && r.out !== '0x' && !r.out.startsWith('0x08c379a0')).map(r => r.label.slice(3));
    // match against historical mint sigs
    const sigMatch = projects.find(p => p.mint?.sig && hits.includes(p.mint.sig));
    return { kind: sigMatch ? 'selector-family' : 'novel', hits, project: sigMatch?.name || null, record: sigMatch || null, impl };
  });
  report.history = history;
  if (history.kind === 'novel' && !basics.sourcify.verified) {
    report.needsAiReview = true;
    report.warnings.push('NOVEL_UNVERIFIED: no historical match and not Sourcify-verified — AI review recommended before any action');
  }

  // ================= STAGE 4: method discovery =================
  const methods = await stage('4_method_discovery', async () => {
    // reuse fingerprint hits; for exact history matches, trust the recorded method
    if (history.kind === 'exact' && history.record.mint?.sig) {
      const m = history.record.mint;
      return { identified: [{ sig: m.sig, selector: m.selector || sel(m.sig), valueWei: m.valueWei, source: 'history-exact' }] };
    }
    const probes = MINT_PROBES.map(([sig, ab]) => ({ to: target, data: sel(sig) + ab(), label: sig }));
    const res = await batchCalls(probes, { from: wallet });
    // a "live" method = call did not revert AND did not return an Error(string) selector
    const live = res.filter(r => r.ok && !(r.out || '').startsWith('0x08c379a0'))
      .map(r => ({ sig: r.label, selector: sel(r.label), source: 'probe' }));
    return { identified: live };
  });
  report.methods = methods;

  // ================= STAGE 5: price / quota / status =================
  const VIEW_PROBES = viewProbes(wallet);
  const state = await stage('5_price_quota_status', async () => {
    const probes = VIEW_PROBES.map(([label, sig, ab]) => ({ to: target, data: sel(sig) + ab(), label }));
    const res = await batchCalls(probes, { from: wallet });
    const out = {};
    for (let i = 0; i < res.length; i++) {
      const r = res[i];
      if (!r.ok) continue;
      try {
        const v = VIEW_PROBES[i][3](r.out);
        if (v !== null && v !== undefined) out[VIEW_PROBES[i][0]] = String(v);
      } catch { /* decoder miss */ }
    }
    // quota from history if exact
    if (history.kind === 'exact' && history.record.quota) out.quotaHint = history.record.quota;
    return out;
  });
  report.state = state;

  // ================= STAGE 6: risk check =================
  const risk = await stage('6_risk_check', async () => {
    const flags = [];
    if (!basics.sourcify.verified) flags.push('unverified-source');
    if (state.owner) {
      if (/^0x0{40}$/i.test(state.owner)) flags.push('owner-zero');
      else {
        const oc = await ethGetCode(state.owner);
        flags.push(oc === '0x' ? 'owner-is-EOA (can rug/pause)' : 'owner-is-contract');
      }
    }
    if (history.impl) flags.push('proxy-upgradable impl=' + history.impl);
    if (basics.codeBytes < 500) flags.push('tiny-code-' + basics.codeBytes + 'b');
    if (state.paused === 'true') flags.push('PAUSED');
    // price anomaly: any price view > 0 means NOT free
    const priceKeys = ['mintPrice', 'price', 'mintFee'].filter(k => state[k] && state[k] !== '0');
    if (priceKeys.length) flags.push('PRICE>0: ' + priceKeys.map(k => `${k}=${state[k]} wei`).join(', '));
    return { flags };
  });
  report.risk = risk;
  if (risk.flags.some(f => f.startsWith('PRICE>0'))) report.warnings.push('NOT_FREE: on-chain price view > 0 — do not treat as free mint');

  // ================= STAGE 7: value-0 simulation =================
  const sim = await stage('7_simulate', async () => {
    const cands = methods.identified.slice(0, 3);
    const results = [];
    for (const m of cands) {
      const probe = MINT_PROBES.find(([s]) => s === m.sig);
      const full = sel(m.sig) + (probe ? probe[1]() : '');
      const res = await batchCalls([{ to: target, data: full, label: m.sig }], { from: wallet, value: '0x0' });
      const r = res[0];
      results.push({ sig: m.sig, ok: r.ok, out: r.ok ? (r.out || '').slice(0, 66) : null, err: r.err || null });
      if (r.ok) break; // first working sim wins
    }
    return { results };
  });
  report.sim = sim;
  const simOk = sim.results.some(r => r.ok);
  if (!simOk) {
    report.warnings.push('SIM_FAIL: all value-0 simulations reverted — ' + (sim.results[0]?.err || 'unknown'));
    if (history.record?.failReason) report.warnings.push('history-note: ' + history.record.failReason);
  }

  report.verdict = verdict(report, basics, risk, simOk, sim, state);
  return finish(report);
}

function verdict(report, basics, risk, simOk, sim, state) {
  if (!basics.hasCode) return 'NO_CONTRACT';
  if (risk.flags.includes('PAUSED')) return 'CLOSED_PAUSED';
  if (risk.flags.some(f => f.startsWith('PRICE>0'))) return 'PAID_NOT_FREE';
  if (!simOk) {
    if (/sold|supply|exceed|max/i.test(sim.results[0]?.err || '') || (/10000/.test(state.totalMinted || '') && state.totalMinted === state.maxSupply)) return 'SOLD_OUT';
    return 'SIM_REVERT';
  }
  const free = !risk.flags.some(f => f.startsWith('PRICE>0'));
  if (free && simOk) return 'FREE_CANDIDATE';
  return 'NEEDS_REVIEW';
}
