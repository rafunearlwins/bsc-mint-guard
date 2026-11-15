// bsc-mint-guard HTTP demo server. Node stdlib only, zero dependencies.
//   GET  /         -> service info (JSON)
//   GET  /health   -> { status: "ok", ... }
//   POST /precheck -> { input, wallet? } runs the 7-stage precheck, returns
//                    the verdict JSON. Read-only: no signing, no payments.
//
// Usage: node scripts/server.mjs [port]   (default 3000, or $PORT)
import { createServer } from 'http';
import { runPrecheck, DEFAULT_WALLET } from './check.mjs';

const PORT = Number(process.argv[2] || process.env.PORT || 3000);
const MAX_BODY = 8192; // 8 KiB is plenty for { input, wallet }
const STARTED = new Date().toISOString();
let served = 0;

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { status: 'ok', service: 'bsc-mint-guard', started: STARTED, prechecksServed: served });
  }
  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, {
      service: 'bsc-mint-guard',
      description: 'Read-only pre-flight guard for BSC (chain 56) mint contracts: identifies the mint method, price, quota and status, flags risks, and proves "free" with a value-0 eth_call simulation.',
      endpoints: {
        'GET /health': 'liveness check',
        'POST /precheck': '{ "input": "<URL|0xCA>", "wallet": "<0x..> (optional)" } -> verdict JSON',
      },
      verdicts: ['FREE_CANDIDATE', 'PAID_NOT_FREE', 'SOLD_OUT', 'CLOSED_PAUSED', 'SIM_REVERT', 'NO_CONTRACT', 'NEEDS_REVIEW'],
      note: 'Read-only. No signing, no approvals, no payments. Default wallet is the zero address; pass "wallet" for quota views.',
    });
  }
  if (req.method === 'POST' && url.pathname === '/precheck') {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(res, 400, { error: 'invalid JSON body' });
      }
      const input = body?.input;
      const wallet = body?.wallet || DEFAULT_WALLET;
      if (typeof input !== 'string' || !input.trim() || input.length > 2048) {
        return send(res, 400, { error: 'input must be a URL or a 0x contract address string' });
      }
      if (typeof wallet !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
        return send(res, 400, { error: 'wallet must be a 0x address' });
      }
      try {
        // A full run takes ~5-30s (throttled RPC batches); generous cap.
        const report = await Promise.race([
          runPrecheck(input.trim(), { wallet }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('precheck timed out after 120s')), 120_000)),
        ]);
        served++;
        return send(res, 200, report);
      } catch (e) {
        return send(res, 502, { error: 'precheck failed: ' + String(e.message || e).slice(0, 200) });
      }
    });
    return;
  }
  return send(res, 404, { error: 'not found', hint: 'GET / for endpoints' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`bsc-mint-guard listening on http://0.0.0.0:${PORT} (GET /health, POST /precheck)`);
});
