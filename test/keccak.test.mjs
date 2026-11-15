// Keccak-256 test vectors. The empty-string digest is the canonical vector;
// the selectors are cross-checked against the project's own on-chain records
// (data/projects.json) and against @noble/hashes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from '../scripts/keccak.mjs';

test('keccak256 empty string', () => {
  assert.equal(
    keccak256(''),
    '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  );
});

test('function selectors match recorded on-chain selectors', () => {
  const cases = {
    'freeMint()': '0x5b70ea9f',
    'mint(uint256)': '0xa0712d68',
    'claimFree()': '0xf366afc9',
    'openFree()': '0x1644fa8e',
    'takeGift()': '0xd33685db',
    'mintGratis()': '0x1c5820bf',
    'mintFree(string)': '0xd56a5cf5',
    'mint(uint8,uint256,uint256,uint256)': '0x848374ec',
  };
  for (const [sig, sel] of Object.entries(cases)) {
    assert.equal(keccak256(sig).slice(0, 10), sel, sig);
  }
});

test('multi-block input is deterministic', () => {
  const a = keccak256('abc'.repeat(100));
  const b = keccak256(Buffer.from('abc'.repeat(100)));
  assert.equal(a, b);
  assert.equal(a, '0x0b4690e744c6ff5f43ac16817124efeaa0b3b3ff9bc26d092984bbb14badeaf5');
});
