// Key generation. The rule under test is absolute: without randomness from the
// phone, no key is produced at all. There is no degraded mode, because the car
// trusts a weak key exactly as much as a strong one.

import { test } from 'node:test'
import assert from 'node:assert'
import crypto from 'node:crypto'

import { createIdentity, PROVENANCE_STRONG } from '../lib/app/identity.js'
import { createSettingsStore, createMemoryBackend } from '../lib/app/settings-store.js'
import { derivePublicKey, isValidPrivateKey } from '../lib/crypto/p256.js'
import { toHex } from '../lib/util/hex.js'

function store () {
  return createSettingsStore(createMemoryBackend())
}

// Stands in for the phone's crypto.getRandomValues.
function phoneEntropy (fill) {
  const bytes = new Uint8Array(48)
  if (fill === undefined) return new Uint8Array(crypto.randomBytes(48))
  bytes.fill(fill)
  return bytes
}

test('generation is refused without randomness from the phone', () => {
  assert.throws(() => createIdentity(store()).generate(null), /no strong randomness/)
  assert.throws(() => createIdentity(store()).generate(undefined), /no strong randomness/)
  assert.throws(() => createIdentity(store()).generate(new Uint8Array(0)), /no strong randomness/)
  // Too little to be a real source.
  assert.throws(() => createIdentity(store()).generate(new Uint8Array(8)), /no strong randomness/)
})

test('there is no override that permits a weak key', () => {
  const identity = createIdentity(store())
  // Older builds accepted an options argument to force generation. Any such
  // call must now still be refused, whatever is passed.
  assert.throws(() => identity.generate(null, { allowWeak: true }), /no strong randomness/)
  assert.throws(() => identity.generate(new Uint8Array(4), { allowWeak: true }), /no strong randomness/)
})

test('a refused generation leaves nothing behind', () => {
  const storage = store()
  const identity = createIdentity(storage)

  assert.throws(() => identity.generate(null))
  assert.ok(!identity.hasKey(), 'a key was stored despite the refusal')
  assert.ok(!identity.hasTrustedKey())
  assert.strictEqual(storage.getPrivateKey(), null)
  assert.strictEqual(storage.getKeyProvenance(), null)
})

test('phone randomness produces a valid, trusted key', () => {
  const storage = store()
  const identity = createIdentity(storage)
  const result = identity.generate(phoneEntropy())

  assert.ok(isValidPrivateKey(result.privateKey))
  assert.strictEqual(result.publicKey.length, 65)
  assert.strictEqual(result.publicKey[0], 0x04)
  assert.strictEqual(toHex(derivePublicKey(result.privateKey)), toHex(result.publicKey))

  assert.ok(identity.hasTrustedKey(), 'a properly made key was not trusted')
  assert.strictEqual(storage.getKeyProvenance(), PROVENANCE_STRONG)
})

test('a key inherited from an older build is not trusted', () => {
  const storage = store()
  const identity = createIdentity(storage)
  identity.generate(phoneEntropy())

  // Simulate a key stored before provenance was recorded.
  storage.setKeyProvenance('')

  assert.ok(identity.hasKey(), 'the key should still be present')
  assert.ok(!identity.hasTrustedKey(), 'an unprovenanced key was trusted')
})

test('the key is persisted and reloads intact', () => {
  const storage = store()
  const identity = createIdentity(storage)
  const generated = identity.generate(phoneEntropy())

  const loaded = identity.load()
  assert.strictEqual(toHex(loaded.privateKey), toHex(generated.privateKey))
  assert.strictEqual(toHex(loaded.publicKey), toHex(generated.publicKey))
})

test('generating a key marks it as not yet enrolled', () => {
  const storage = store()
  storage.setEnrolled(true)

  createIdentity(storage).generate(phoneEntropy())
  assert.ok(!storage.isEnrolled(), 'a fresh key was treated as already enrolled')
})

test('different phone entropy yields different keys', () => {
  const a = createIdentity(store()).generate(phoneEntropy(0x11))
  const b = createIdentity(store()).generate(phoneEntropy(0x22))
  assert.notStrictEqual(toHex(a.privateKey), toHex(b.privateKey))
})

test('watch entropy is mixed in, so identical phone bytes still differ', () => {
  // A phone replaying the same bytes must not pin the key down by itself.
  const fixed = phoneEntropy(0x5a)
  const first = createIdentity(store()).generate(fixed)
  const second = createIdentity(store()).generate(fixed)

  assert.notStrictEqual(toHex(first.privateKey), toHex(second.privateKey),
    'the key depended only on the phone')
})

test('scan observations are folded in and bounded', () => {
  const identity = createIdentity(store())
  for (let i = 0; i < 5; i++) identity.observe(new Uint8Array(crypto.randomBytes(8)))
  assert.strictEqual(identity.generate(phoneEntropy()).observationCount, 5)

  const flooded = createIdentity(store())
  for (let i = 0; i < 500; i++) flooded.observe(new Uint8Array([i & 0xff]))
  assert.ok(flooded.generate(phoneEntropy()).observationCount <= 64,
    'observation buffer grew without limit')
})

test('a corrupt stored key reads as absent rather than being used', () => {
  const storage = store()
  const identity = createIdentity(storage)
  identity.generate(phoneEntropy())

  storage.setKeyPair(new Uint8Array(32), new Uint8Array(65))
  assert.ok(!identity.hasKey(), 'an out-of-range private key was accepted')
  assert.ok(!identity.hasTrustedKey())
  assert.strictEqual(identity.load(), null)
})
