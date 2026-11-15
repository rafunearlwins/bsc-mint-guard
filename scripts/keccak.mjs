// Pure-JavaScript Keccak-256 (NOT NIST SHA3-256: Keccak uses 0x01 padding,
// SHA3 uses 0x06). Ethereum function selectors and code hashes need Keccak.
// Zero dependencies; BigInt lanes keep the implementation short and auditable.
//
// Test vectors (verified against the project's own on-chain data):
//   keccak256("")              -> c5d24601...85a470
//   keccak256("freeMint()")    -> 5b70ea9f...  (selector 0x5b70ea9f)
//   keccak256("mint(uint256)") -> a0712d68...  (selector 0xA0712d68)
//   keccak256("claimFree()")   -> f366afc9...  (selector 0xf366afc9)

const MASK64 = (1n << 64n) - 1n;

// Round constants, Keccak-f[1600], 24 rounds.
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rotation offsets r[x][y] (lane index = x + 5*y).
const R = [
  [0n, 36n, 3n, 41n, 18n],
  [1n, 44n, 10n, 45n, 2n],
  [62n, 6n, 43n, 15n, 61n],
  [28n, 55n, 25n, 21n, 56n],
  [27n, 20n, 39n, 8n, 14n],
];

function rotl(v, n) {
  if (n === 0n) return v;
  return ((v << n) | (v >> (64n - n))) & MASK64;
}

function keccakF(state) {
  for (let round = 0; round < 24; round++) {
    // Theta
    const C = [];
    for (let x = 0; x < 5; x++) {
      C[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n);
      for (let y = 0; y < 5; y++) state[x + 5 * y] ^= D;
    }
    // Rho + Pi
    const B = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y], R[x][y]);
      }
    }
    // Chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + 5 * y] = (B[x + 5 * y] ^ ((~B[((x + 1) % 5) + 5 * y]) & B[((x + 2) % 5) + 5 * y])) & MASK64;
      }
    }
    // Iota
    state[0] ^= RC[round];
  }
}

const RATE = 136; // Keccak-256: rate 1088 bits = 136 bytes.

/**
 * Keccak-256 digest of `data` (string, Uint8Array, or Buffer).
 * Returns a 0x-prefixed 64-hex-char string.
 */
export function keccak256(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const state = new Array(25).fill(0n);

  // Absorb full blocks.
  let offset = 0;
  while (offset + RATE <= bytes.length) {
    absorbBlock(state, bytes, offset);
    offset += RATE;
  }

  // Final block with pad10*1 (Keccak padding: 0x01 ... 0x80).
  const tail = new Uint8Array(RATE);
  tail.set(bytes.subarray(offset));
  tail[bytes.length - offset] = 0x01;
  tail[RATE - 1] |= 0x80;
  absorbBlock(state, tail, 0);

  // Squeeze 32 bytes (first 4 lanes, little-endian).
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let v = state[i];
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number(v & 0xffn);
      v >>= 8n;
    }
  }
  return '0x' + Buffer.from(out).toString('hex');
}

function absorbBlock(state, bytes, offset) {
  for (let i = 0; i < RATE / 8; i++) {
    let lane = 0n;
    for (let j = 0; j < 8; j++) {
      lane |= BigInt(bytes[offset + i * 8 + j]) << BigInt(8 * j);
    }
    state[i] ^= lane;
  }
  keccakF(state);
}
