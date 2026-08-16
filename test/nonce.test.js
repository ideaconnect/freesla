// Nonce uniqueness under AES-GCM is not a nice-to-have: two commands sharing a
// nonce under one session key leak the GHASH subkey and let an attacker forge
// arbitrary commands to the car.
//
// The point of the counter construction is that this holds even when the random
// source is worthless, so these tests deliberately supply a broken one.

import { test } from 'node:test'
import assert from 'node:assert'

import { createNonceSource } from '../lib/tesla/nonce.js'
import { createSettingsStore, createMemoryBackend } from '../lib/app/settings-store.js'
import { toHex } from '../lib/util/hex.js'

// The worst realistic source: a watch whose clock reset, so every launch
// reseeds identically and returns the same bytes forever.
function brokenRandom (n) {
  return new Uint8Array(n).fill(0xab)
}

function freshStore () {
  return createSettingsStore(createMemoryBackend())
}

test('a nonce is 12 bytes and the counter advances', () => {
  const source = createNonceSource(freshStore(), brokenRandom)

  const a = source()
  const b = source()
  assert.strictEqual(a.length, 12)
  assert.strictEqual(b.length, 12)

  // Same 4-byte device prefix, differing 8-byte counter.
  assert.strictEqual(toHex(a.subarray(0, 4)), toHex(b.subarray(0, 4)))
  assert.notStrictEqual(toHex(a.subarray(4)), toHex(b.subarray(4)))
})

test('nonces never repeat across restarts, even with a broken random source', () => {
  // The scenario this construction exists for: the RNG returns identical bytes
  // every time, as it would after an RTC reset reseeded the DRBG identically.
  const storage = freshStore()
  const seen = new Set()

  for (let restart = 0; restart < 25; restart++) {
    const source = createNonceSource(storage, brokenRandom, 8)
    for (let i = 0; i < 8; i++) {
      const nonce = toHex(source())
      assert.ok(!seen.has(nonce), 'nonce repeated after restart ' + restart + ': ' + nonce)
      seen.add(nonce)
    }
  }

  assert.strictEqual(seen.size, 200)
})

test('a crash mid-block skips values rather than reissuing them', () => {
  const storage = freshStore()
  const seen = new Set()

  // Each iteration abandons its block after a single draw, modelling a flat
  // battery. Reissuing the unused values would be the dangerous outcome.
  for (let crash = 0; crash < 30; crash++) {
    const source = createNonceSource(storage, brokenRandom, 64)
    const nonce = toHex(source())
    assert.ok(!seen.has(nonce), 'a reserved-but-unused counter was reissued')
    seen.add(nonce)
  }

  assert.strictEqual(seen.size, 30)
})

test('the counter continues past the end of a reserved block', () => {
  const storage = freshStore()
  const source = createNonceSource(storage, brokenRandom, 4)

  const seen = new Set()
  // Four blocks' worth, forcing three re-reservations.
  for (let i = 0; i < 16; i++) seen.add(toHex(source()))

  assert.strictEqual(seen.size, 16, 'a nonce repeated when crossing a block boundary')
})

test('the device prefix is generated once and then reused', () => {
  const storage = freshStore()

  const first = createNonceSource(storage, brokenRandom)()
  const stored = storage.getNoncePrefix()
  assert.strictEqual(toHex(stored), toHex(first.subarray(0, 4)))

  // A different random source must not change an established prefix, or old
  // and new nonces could collide on the counter alone.
  const second = createNonceSource(storage, (n) => new Uint8Array(n).fill(0x11))()
  assert.strictEqual(toHex(second.subarray(0, 4)), toHex(stored))
})

test('the counter is encoded big-endian and carries correctly', () => {
  const storage = freshStore()
  // Reserve a block starting just below a byte boundary to exercise the carry.
  storage.reserveNonceBlock(255)

  const source = createNonceSource(storage, brokenRandom, 4)
  const first = source()
  const second = source()

  assert.strictEqual(toHex(first.subarray(4)), '00000000000000ff')
  assert.strictEqual(toHex(second.subarray(4)), '0000000000000100')
})

test('a large counter is still encoded exactly', () => {
  const storage = freshStore()
  // Far beyond any realistic use, and still inside exact double range.
  storage.reserveNonceBlock(4294967296)

  const nonce = createNonceSource(storage, brokenRandom, 2)()
  assert.strictEqual(toHex(nonce.subarray(4)), '0000000100000000')
})

test('a long run of commands produces no duplicates', () => {
  const source = createNonceSource(freshStore(), brokenRandom, 64)
  const seen = new Set()

  for (let i = 0; i < 5000; i++) seen.add(toHex(source()))
  assert.strictEqual(seen.size, 5000)
})
