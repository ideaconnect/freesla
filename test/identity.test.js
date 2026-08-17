// The watch's key identity.
//
// The keypair is made on the phone and installed here; the watch does no
// asymmetric maths of its own, for two independent reasons either of which
// would be enough. Zepp OS has no cryptographically secure RNG, so a
// watch-chosen key would be guessable against a public key that travels in the
// clear over BLE. And deriving a public key is ~87 seconds on that
// interpreter, with no native crypto anywhere on the platform to fall back on.
//
// What is left to test here is the gate: what this module agrees to keep, and
// what it refuses.

import { test } from 'node:test'
import assert from 'node:assert'
import crypto from 'node:crypto'

import { createIdentity, PROVENANCE_STRONG } from '../lib/app/identity.js'
import { createSettingsStore, createMemoryBackend } from '../lib/app/settings-store.js'
import { derivePublicKey, generatePrivateKey, isValidPrivateKey } from '../lib/crypto/p256.js'
import { toHex } from '../lib/util/hex.js'

function store () {
  return createSettingsStore(createMemoryBackend())
}

function randomBytes (n) {
  return new Uint8Array(crypto.randomBytes(n))
}

// What the phone sends: a keypair from its own CSPRNG.
function phoneKeyPair () {
  const privateKey = generatePrivateKey(randomBytes)
  return { privateKey, publicKey: derivePublicKey(privateKey) }
}

test('the watch does no curve arithmetic of its own', async () => {
  // Guarded as source text because the cost is a property of the runtime, not
  // of the result: every one of these returns the right answer under Node, in
  // 14ms, which is exactly why no behavioural test would ever catch it. On the
  // watch the same call is 87 seconds, and the one that used to be reachable
  // ran inside a native Bluetooth callback, which reset the device.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../lib/app/identity.js', import.meta.url), 'utf8')

  const banned = ['derivePublicKey', 'generatePrivateKey', 'ecdh', 'scalarMult']
  for (const name of banned) {
    assert.ok(!new RegExp('\\b' + name + '\\s*\\(').test(source),
      'identity.js calls ' + name + '(), which is 87 seconds on the watch')
  }
})

test('a keypair from the phone is kept and marked as trusted', () => {
  const storage = store()
  const identity = createIdentity(storage)
  const { privateKey, publicKey } = phoneKeyPair()

  const result = identity.installKeyPair(privateKey, publicKey)

  assert.ok(isValidPrivateKey(result.privateKey))
  assert.strictEqual(result.publicKey.length, 65)
  assert.strictEqual(result.publicKey[0], 0x04)
  assert.ok(identity.hasTrustedKey(), 'a properly supplied key was not trusted')
  assert.strictEqual(storage.getKeyProvenance(), PROVENANCE_STRONG)
})

test('an unusable private key is refused and nothing is stored', () => {
  const { publicKey } = phoneKeyPair()

  for (const [what, bad] of [
    ['nothing at all', null],
    ['the wrong length', new Uint8Array(16)],
    ['zero', new Uint8Array(32)],
    ['a scalar at or past the curve order', new Uint8Array(32).fill(0xff)]
  ]) {
    const storage = store()
    const identity = createIdentity(storage)
    assert.throws(() => identity.installKeyPair(bad, publicKey), /unusable private key/,
      what + ' was accepted')
    assert.strictEqual(storage.getPrivateKey(), null, what + ' reached storage')
    assert.strictEqual(storage.getKeyProvenance(), null)
  }
})

test('a public key that is not on the curve is refused', () => {
  // Not pedantry: accepting an off-curve point is how an invalid-curve attack
  // starts, and "the phone said so" is not a reason to store a car key.
  const storage = store()
  const identity = createIdentity(storage)
  const { privateKey, publicKey } = phoneKeyPair()

  const bent = new Uint8Array(publicKey)
  bent[40] ^= 0xff

  assert.throws(() => identity.installKeyPair(privateKey, bent), /not on the curve/)
  assert.throws(() => identity.installKeyPair(privateKey, publicKey.subarray(0, 40)), /not on the curve/)
  assert.strictEqual(storage.getPrivateKey(), null, 'a bad pair reached storage')
})

test('the halves are deliberately not checked against each other', () => {
  // Confirming that they correspond means deriving the public key, which is the
  // ninety seconds this whole arrangement exists to avoid. A mismatched pair is
  // not a safety problem: the car simply never accepts it, visibly, at
  // enrolment.
  const identity = createIdentity(store())
  const a = phoneKeyPair()
  const b = phoneKeyPair()

  assert.ok(identity.installKeyPair(a.privateKey, b.publicKey),
    'a mismatched pair was rejected, which means something derived a key')
})

test('a key inherited from an older build is not trusted', () => {
  const storage = store()
  const identity = createIdentity(storage)
  const { privateKey, publicKey } = phoneKeyPair()
  identity.installKeyPair(privateKey, publicKey)

  // Simulate a key stored before provenance was recorded.
  storage.setKeyProvenance('')

  assert.ok(identity.hasKey(), 'the key should still be present')
  assert.ok(!identity.hasTrustedKey(), 'an unprovenanced key was trusted')
})

test('the key is persisted and reloads intact', () => {
  const storage = store()
  const identity = createIdentity(storage)
  const { privateKey, publicKey } = phoneKeyPair()
  identity.installKeyPair(privateKey, publicKey)

  const loaded = identity.load()
  assert.strictEqual(toHex(loaded.privateKey), toHex(privateKey))
  assert.strictEqual(toHex(loaded.publicKey), toHex(publicKey))
})

test('installing a key marks it as not yet enrolled', () => {
  const storage = store()
  storage.setEnrolled(true)

  const { privateKey, publicKey } = phoneKeyPair()
  createIdentity(storage).installKeyPair(privateKey, publicKey)
  assert.ok(!storage.isEnrolled(), 'a fresh key was treated as already enrolled')
})

test('scan observations are collected and bounded', () => {
  // No longer key material -- the key comes from the phone -- but the watch
  // still draws routing addresses and request uuids locally, and an unbounded
  // buffer on a watch heap is its own problem.
  const identity = createIdentity(store())
  for (let i = 0; i < 5; i++) identity.observe(randomBytes(8))
  assert.strictEqual(identity.entropySources().length, 5)

  const flooded = createIdentity(store())
  for (let i = 0; i < 500; i++) flooded.observe(new Uint8Array([i & 0xff]))
  assert.ok(flooded.entropySources().length <= 64, 'observation buffer grew without limit')
})

test('a corrupt stored key reads as absent rather than being used', () => {
  const storage = store()
  const identity = createIdentity(storage)
  const { privateKey, publicKey } = phoneKeyPair()
  identity.installKeyPair(privateKey, publicKey)

  storage.setKeyPair(new Uint8Array(32), new Uint8Array(65))
  assert.ok(!identity.hasKey(), 'an out-of-range private key was accepted')
  assert.ok(!identity.hasTrustedKey())
  assert.strictEqual(identity.load(), null)
})
