import { test } from 'node:test'
import assert from 'node:assert'
import crypto from 'node:crypto'

import { toHex, fromHex } from '../lib/util/hex.js'
import { normaliseVin } from '../lib/app/identity.js'
import { cleanVin } from '../lib/app/vin.js'
import { createDrbg, collectWatchEntropy } from '../lib/crypto/random.js'

test('hex round trips arbitrary bytes', () => {
  for (const n of [1, 16, 32, 65, 200]) {
    const bytes = new Uint8Array(crypto.randomBytes(n))
    const encoded = toHex(bytes)
    assert.strictEqual(encoded.length, n * 2)
    assert.deepStrictEqual(Array.from(fromHex(encoded)), Array.from(bytes))
  }
})

test('hex rejects malformed input rather than guessing', () => {
  assert.strictEqual(fromHex('abc'), null, 'odd length accepted')
  assert.strictEqual(fromHex('zz'), null, 'non-hex accepted')
  // Empty decodes to null rather than an empty array on purpose: watch storage
  // returns '' for an unset key, and that has to read as absent.
  assert.strictEqual(fromHex(''), null, 'empty should read as absent')
})

test('hex accepts upper case', () => {
  assert.deepStrictEqual(Array.from(fromHex('DEADBEEF')), [0xde, 0xad, 0xbe, 0xef])
})

test('vin normalisation strips punctuation and upper-cases', () => {
  assert.strictEqual(normaliseVin('5yj30123456789abc'), '5YJ30123456789ABC')
  assert.strictEqual(normaliseVin(' 5YJ3-0123 4567 89ABC '), '5YJ30123456789ABC')
})

test('vin normalisation rejects invalid vins', () => {
  assert.strictEqual(normaliseVin(''), null, 'empty accepted')
  assert.strictEqual(normaliseVin('5YJ3012345678'), null, 'short accepted')
  assert.strictEqual(normaliseVin('5YJ30123456789ABCD'), null, 'long accepted')
  // I, O and Q are never used in a VIN precisely because they read as 1 and 0.
  assert.strictEqual(normaliseVin('5YJ30123456789ABI'), null, 'I accepted')
  assert.strictEqual(normaliseVin('5YJ30123456789ABO'), null, 'O accepted')
  assert.strictEqual(normaliseVin('5YJ30123456789ABQ'), null, 'Q accepted')
})

test('the loose vin tidy keeps partial input usable', () => {
  // What the phone stores while the owner is still typing. Rejecting an
  // incomplete VIN here would mean the field could never be filled in, so this
  // one only tidies -- deciding whether a VIN is real is normaliseVin's job.
  assert.strictEqual(cleanVin('5yj3-01'), '5YJ301')
  assert.strictEqual(cleanVin(''), '')
  assert.strictEqual(cleanVin(null), '')
  assert.strictEqual(cleanVin(undefined), '')
  // Deliberately not validated: this is a prefix, not a verdict.
  assert.strictEqual(cleanVin('5YJ30123456789ABCDEF'), '5YJ30123456789ABCDEF')
})

test('the drbg is deterministic for a seed and varies across seeds', () => {
  const a = createDrbg(new Uint8Array([1, 2, 3]))
  const b = createDrbg(new Uint8Array([1, 2, 3]))
  const c = createDrbg(new Uint8Array([1, 2, 4]))

  assert.strictEqual(toHex(a(32)), toHex(b(32)), 'same seed diverged')
  assert.notStrictEqual(toHex(createDrbg(new Uint8Array([1, 2, 3]))(32)), toHex(c(32)))
})

test('the drbg produces distinct successive blocks of any length', () => {
  const random = createDrbg(new Uint8Array([9, 9, 9]))
  const seen = new Set()
  for (let i = 0; i < 40; i++) {
    const block = toHex(random(32))
    assert.ok(!seen.has(block), 'drbg repeated a block')
    seen.add(block)
  }

  for (const n of [1, 12, 31, 32, 33, 64, 100]) {
    assert.strictEqual(random(n).length, n, 'wrong length for ' + n)
  }
})

test('watch entropy collection varies between calls', () => {
  // Cannot assert real entropy, only that the pool is not a constant -- a
  // fixed seed here would mean every watch generated the same key.
  const first = toHex(collectWatchEntropy(null))
  const second = toHex(collectWatchEntropy(null))
  assert.notStrictEqual(first, second, 'entropy pool is deterministic')
})

test('extra entropy sources are folded in and failures tolerated', () => {
  const withSource = collectWatchEntropy([() => new Uint8Array([1, 2, 3])])
  const withThrow = collectWatchEntropy([() => { throw new Error('no sensor') }])

  assert.ok(withSource.length > 0)
  // A missing sensor must never stop key generation.
  assert.ok(withThrow.length > 0)
})
