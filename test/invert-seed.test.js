// The seed inverter has to be right in both directions. A broken search would
// report NO MATCH and falsely reassure someone that their car key is safe,
// which is the worst failure this project could have.

import { test } from 'node:test'
import assert from 'node:assert'

import {
  xorshift64star, mantissa, expectedMantissas, search,
  mantissaToDouble, doubleToMantissa
} from '../tools/invert-seed.js'

test('xorshift64star stays inside 64 bits', () => {
  let state = 0x123456789abcdefn
  for (let i = 0; i < 200; i++) {
    const step = xorshift64star(state)
    assert.ok(step.state < (1n << 64n), 'state overflowed')
    assert.ok(step.output < (1n << 64n), 'output overflowed')
    assert.ok(step.state > 0n, 'state collapsed to zero')
    state = step.state
  }
})

test('the generator does not cycle quickly', () => {
  const seen = new Set()
  let state = 1n
  for (let i = 0; i < 5000; i++) {
    state = xorshift64star(state).state
    assert.ok(!seen.has(state), 'state repeated after ' + i + ' steps')
    seen.add(state)
  }
})

test('mantissa extraction is the top 52 bits', () => {
  const output = 0xffffffffffffffffn
  assert.strictEqual(mantissa(output), (1n << 52n) - 1n)
  assert.strictEqual(mantissa(0n), 0n)
})

test('mantissa and double conversions round trip', () => {
  // Math.random doubles are exactly k / 2^52, so this must be lossless.
  for (const m of [0n, 1n, 12345678901234n, (1n << 52n) - 1n]) {
    assert.strictEqual(doubleToMantissa(mantissaToDouble(m)), m, 'failed for ' + m)
  }
})

test('a known seed is recovered from its first two outputs', () => {
  // 2026-08-16T00:00:00Z in microseconds, a plausible launch timestamp.
  const seed = 1786924800000000n
  const expected = expectedMantissas(seed)

  const found = search(seed - 5000n, seed + 5000n, expected.first, expected.second)
  assert.strictEqual(found, seed, 'the inverter failed to recover a known seed')
})

test('the seed is recovered from the far end of a window', () => {
  const seed = 1786924800123456n
  const expected = expectedMantissas(seed)

  // The seed sits at the very start of the range, the worst case for an
  // off-by-one in the loop bounds.
  assert.strictEqual(search(seed, seed + 20000n, expected.first, expected.second), seed)
  // And at the very end, checking the bound is inclusive.
  assert.strictEqual(search(seed - 20000n, seed, expected.first, expected.second), seed)
})

test('a search that excludes the seed reports no match', () => {
  const seed = 1786924800000000n
  const expected = expectedMantissas(seed)

  const found = search(seed + 1n, seed + 20000n, expected.first, expected.second)
  assert.strictEqual(found, null, 'reported a hit outside the true seed')
})

test('unrelated targets do not produce a spurious hit', () => {
  const found = search(1786924800000000n, 1786924800050000n, 0x1234567890abcn, 0xfedcba0987654n)
  assert.strictEqual(found, null, 'matched targets that no seed produces')
})

test('requiring both outputs rejects a single-output coincidence', () => {
  const seed = 1786924800777777n
  const real = expectedMantissas(seed)

  // Correct first output, wrong second: must not be accepted.
  const found = search(seed - 100n, seed + 100n, real.first, real.second ^ 1n)
  assert.strictEqual(found, null, 'accepted a match on the first output alone')
})

test('a zero seed is normalised the way quickjs does', () => {
  // QuickJS forces a zero state to 1, since xorshift is stuck at zero.
  assert.deepStrictEqual(expectedMantissas(0n), expectedMantissas(1n))
})
