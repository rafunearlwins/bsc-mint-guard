// bsc-mint-guard shared library: RPC batching, throttling, selectors, decoding.
// Zero dependencies — keccak256 is vendored in ./keccak.mjs (pure JS).
// Everything here is READ-ONLY: eth_call / eth_getCode / eth_getStorageAt only.
import { keccak256 } from './keccak.mjs';

export const RPC = 'https://bsc-dataseed.bnbchain.org';
export const CHAIN_ID = 56;

// Known infra addresses to EXCLUDE when extracting contracts from a page
// (WBNB, USDT, BUSD, PancakeSwap V2 router, SPACE ID registry).
export const INFRA = new Set([
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  '0x55d398326f99059f775485d720157aa3361a6f6',
  '0xe9e7cea3dedca5984780bafc599bd69add087d8b',
  '0x10ed43c718714eb63d5aa57b78b54704e256024e',
  '0x60b9262456de011f7d15a54cdd8c48baaa8b022f',
].map(s => s.toLowerCase()));

let _id = 1;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- selectors & encoding (selectors are COMPUTED, never guessed) ----
export const sel = sig => keccak256(sig).slice(0, 10);
export const padAddr = a => a.toLowerCase().replace('0x', '').padStart(64, '0');
export const padUint = n => BigInt(n).toString(16).padStart(64, '0');
export const codehash = code => keccak256(Buffer.from(code.slice(2), 'hex'));

// EIP-1967 implementation slot
export const EIP1967_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

// ---- decoding ----
export function decUint(hex, word = 0) {
  if (!hex || hex === '0x') return null;
  const h = hex.slice(2);
  const s = h.slice(64 * word, 64 * (word + 1));
  if (s.length < 64) return null;
  return BigInt('0x' + s);
}
export function decBool(hex, word = 0) { const v = decUint(hex, word); return v === null ? null : v !== 0n; }
export function decAddr(hex, word = 0) {
  if (!hex || hex === '0x') return null;
  const h = hex.slice(2).slice(64 * word, 64 * (word + 1));
  if (h.length < 64) return null;
  return '0x' + h.slice(24);
}
export function decString(hex) {
  if (!hex || hex === '0x' || hex.length < 194) return null;
  try {
    const len = Number(decUint(hex, 1));
    const data = hex.slice(2 + 128, 2 + 128 + len * 2);
    return Buffer.from(data, 'hex').toString('utf8').replace(/\0+$/, '');
  } catch { return null; }
}

// ---- RPC ----
async function rawBatch(payloads, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payloads),
      });
      const j = await r.json();
      return Array.isArray(j) ? j : [j];
    } catch (e) {
      if (attempt === retries) throw e;
      await sleep(800 * (attempt + 1));
    }
  }
}

/**
 * Batch eth_call probes. calls: [{to, data, value?, from?, label?}]
 * Returns: [{label, ok, out|null, err?}]
 * Throttled to stay under bsc-dataseed rate limits.
 */
export async function batchCalls(calls, { from = null, value = '0x0', throttleMs = 500 } = {}) {
  const out = [];
  const CHUNK = 12; // keep batches modest
  for (let i = 0; i < calls.length; i += CHUNK) {
    const chunk = calls.slice(i, i + CHUNK);
    const payloads = chunk.map(c => ({
      jsonrpc: '2.0', id: _id++,
      method: 'eth_call',
      params: [{ to: c.to, data: c.data, ...(from ? { from } : {}), ...(c.value || value !== '0x0' ? { value: c.value || value } : {}) }, 'latest'],
    }));
    const res = await rawBatch(payloads);
    for (let k = 0; k < chunk.length; k++) {
      const r = res[k] || {};
      if (r.error) out.push({ label: chunk[k].label, ok: false, out: null, err: shortErr(r.error) });
      else out.push({ label: chunk[k].label, ok: true, out: r.result });
    }
    if (i + CHUNK < calls.length) await sleep(throttleMs);
  }
  return out;
}

function shortErr(e) {
  const m = (e.message || JSON.stringify(e)).slice(0, 160);
  // extract common revert reasons
  const rm = m.match(/reverted(?::\s*([^,}"]+))?/i);
  return rm ? 'revert' + (rm[1] ? ': ' + rm[1].trim().slice(0, 80) : '') : m;
}

export async function ethGetCode(addr) {
  const [r] = await rawBatch([{ jsonrpc: '2.0', id: _id++, method: 'eth_getCode', params: [addr, 'latest'] }]);
  if (r.error) throw new Error('eth_getCode: ' + JSON.stringify(r.error).slice(0, 120));
  return r.result;
}

export async function ethGetBalance(addr) {
  const [r] = await rawBatch([{ jsonrpc: '2.0', id: _id++, method: 'eth_getBalance', params: [addr, 'latest'] }]);
  if (r.error) throw new Error('eth_getBalance: ' + JSON.stringify(r.error).slice(0, 120));
  return BigInt(r.result);
}

export async function ethGetStorageAt(addr, slot) {
  const [r] = await rawBatch([{ jsonrpc: '2.0', id: _id++, method: 'eth_getStorageAt', params: [addr, slot, 'latest'] }]);
  if (r.error) return null;
  return r.result;
}

// ---- Sourcify verification ----
export async function sourcifyStatus(addr) {
  try {
    const r = await fetch(`https://sourcify.dev/server/v2/contract/${CHAIN_ID}/${addr}`, { signal: AbortSignal.timeout(12000) });
    if (r.status === 404) return { verified: false };
    const j = await r.json();
    const m = j.creationMatch || j.deploymentMatch || j.runtimeMatch || null;
    return { verified: !!m, match: m || null, name: j.name || null };
  } catch { return { verified: 'unknown', error: true }; }
}

// ---- page -> contract candidates ----
const ADDR_RE = /0x[a-fA-F0-9]{40}/g;
export async function extractContracts(url) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
  });
  const html = await r.text();
  const found = new Map(); // addr(lower) -> {count, nearMint}
  let m;
  while ((m = ADDR_RE.exec(html)) !== null) {
    const a = m[0].toLowerCase();
    if (INFRA.has(a)) continue;
    if (/^0x0{38,40}$/.test(a)) continue;
    const ctx = html.slice(Math.max(0, m.index - 120), m.index + 160).toLowerCase();
    const nearMint = /mint|contract|claim|nft|free|presale|deploy/.test(ctx);
    const e = found.get(a) || { count: 0, nearMint: false };
    e.count++;
    e.nearMint = e.nearMint || nearMint;
    found.set(a, e);
  }
  return [...found.entries()]
    .map(([addr, v]) => ({ addr, ...v }))
    .sort((x, y) => (y.nearMint - x.nearMint) || (y.count - x.count));
}
