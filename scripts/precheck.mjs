#!/usr/bin/env node
// bsc-mint-guard CLI: URL-or-CA -> mint contract identification, price, quota,
// status, risk check, value-0 simulation. Read-only. Never signs, never pays.
// Usage: node precheck.mjs <URL|0xCA> [--wallet 0x..] [--json] [--out file.json]
import { writeFileSync } from 'fs';
import { runPrecheck, DEFAULT_WALLET } from './check.mjs';

const args = process.argv.slice(2);
const input = args.find(a => !a.startsWith('--'));
const walletIdx = args.indexOf('--wallet');
const wallet = (walletIdx >= 0 ? args[walletIdx + 1] : null) || DEFAULT_WALLET;
const asJson = args.includes('--json');
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
if (!input) {
  console.error('Usage: node precheck.mjs <URL|0xCA> [--wallet 0x..] [--json] [--out file]');
  console.error('  --wallet defaults to the zero address (on-chain facts only; pass your');
  console.error('  address for balanceOf/mintedBy quota views).');
  process.exit(2);
}

const report = await runPrecheck(input, { wallet });
const body = asJson ? JSON.stringify(report, null, 2) : human(report);
if (outFile) writeFileSync(outFile, asJson ? body : JSON.stringify(report, null, 2));
console.log(body);

function human(r) {
  const L = [];
  L.push(`=== BSC Mint Precheck ===`);
  L.push(`input   : ${r.input}`);
  L.push(`wallet  : ${r.wallet || '-'} (quota/balance reads use this address)`);
  L.push(`target  : ${r.target?.addr || '-'} (${r.target?.source || '-'})`);
  if (r.target?.alternates?.length) L.push(`alternates: ${r.target.alternates.join(', ')}`);
  L.push(`code    : ${r.basics?.hasCode ? r.basics.codeBytes + ' bytes' : 'NONE'} | sourcify: ${r.basics?.sourcify?.verified === true ? 'verified' : r.basics?.sourcify?.verified}`);
  L.push(`history : ${r.history?.kind}${r.history?.project ? ' -> ' + r.history.project : ''}`);
  if (r.history?.hits?.length) L.push(`mint-sigs on-chain: ${r.history.hits.join(', ')}`);
  L.push(`methods : ${(r.methods?.identified || []).map(m => m.sig + ' [' + m.source + ']').join(', ') || '-'}`);
  const s = r.state || {};
  L.push(`state   : ` + ['name', 'symbol', 'totalMinted', 'totalSupply', 'maxSupply', 'mintPrice', 'price', 'paused', 'mintOpen', 'mintLive', 'balanceOf', 'mintedBy', 'freeAvailable'].filter(k => s[k] !== undefined).map(k => `${k}=${s[k]}`).join(' | '));
  if (s.quotaHint) L.push(`quota   : ${s.quotaHint} (history)`);
  L.push(`risk    : ${(r.risk?.flags || []).join('; ') || 'none'}`);
  L.push(`sim     : ${(r.sim?.results || []).map(x => `${x.sig}: ${x.ok ? 'OK' : 'REVERT ' + (x.err || '')}`).join(' | ') || '-'}`);
  L.push(`verdict : ${r.verdict}`);
  if (r.warnings.length) L.push(`warnings:\n  - ${r.warnings.join('\n  - ')}`);
  if (r.needsAiReview) L.push(`>> needs AI review (novel + unverified)`);
  L.push(`timings : ` + Object.entries(r.stages || {}).map(([k, v]) => `${k}=${v}ms`).join(' '));
  L.push(`note    : read-only. No signature, no approval, no payment was made.`);
  return L.join('\n');
}
