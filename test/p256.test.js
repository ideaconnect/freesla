// Cross-checks the pure-JS P-256 against Node's OpenSSL-backed implementation.
// Agreement on public-key derivation and on shared secrets in both directions
// is what makes the watch-side key trustworthy.

import { test } from 'node:test'
import assert from 'node:assert'
import crypto from 'node:crypto'

import {
  derivePublicKey,
  ecdh,
  decodePublicKey,
  generatePrivateKey,
  isValidPrivateKey,
  bytesToLimbs,
  limbsToBytes
} from '../lib/crypto/p256.js'

function hex (u8) {
  return Buffer.from(u8).toString('hex')
}

function nodeKeyPair () {
  const ec = crypto.createECDH('prime256v1')
  ec.generateKeys()
  return { ec, priv: new Uint8Array(ec.getPrivateKey(null, 'buffer')), pub: new Uint8Array(ec.getPublicKey(null, 'uncompressed')) }
}

test('limb conversion round trips', () => {
  for (let i = 0; i < 50; i++) {
    const bytes = new Uint8Array(crypto.randomBytes(32))
    assert.strictEqual(hex(limbsToBytes(bytesToLimbs(bytes))), hex(bytes))
  }
})

test('public key derivation matches node', () => {
  for (let i = 0; i < 8; i++) {
    const { ec, priv } = nodeKeyPair()
    // Node may return a short private key; left-pad to 32 bytes.
    const padded = new Uint8Array(32)
    padded.set(priv, 32 - priv.length)

    const expected = new Uint8Array(ec.getPublicKey(null, 'uncompressed'))
    assert.strictEqual(hex(derivePublicKey(padded)), hex(expected), `trial ${i}`)
  }
})

test('base point times one is the generator', () => {
  const one = new Uint8Array(32)
  one[31] = 1
  const pub = derivePublicKey(one)
  assert.strictEqual(
    hex(pub),
    '046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296' +
    '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5'
  )
})

test('ecdh agrees with node in both directions', () => {
  for (let i = 0; i < 6; i++) {
    const alice = nodeKeyPair()
    const bob = nodeKeyPair()

    const alicePriv = new Uint8Array(32)
    alicePriv.set(alice.priv, 32 - alice.priv.length)

    // Our side computes alice*bobPub; Node computes bob*alicePub.
    const ours = ecdh(alicePriv, bob.pub)
    const theirs = new Uint8Array(bob.ec.computeSecret(Buffer.from(alice.pub)))

    assert.notStrictEqual(ours, null, 'ecdh returned null')
    assert.strictEqual(hex(ours), hex(theirs), `trial ${i}`)
  }
})

test('ecdh matches node when our public key is the one shared', () => {
  const ourPriv = generatePrivateKey((n) => new Uint8Array(crypto.randomBytes(n)))
  const ourPub = derivePublicKey(ourPriv)

  const peer = nodeKeyPair()
  const ours = ecdh(ourPriv, peer.pub)
  const theirs = new Uint8Array(peer.ec.computeSecret(Buffer.from(ourPub)))

  assert.strictEqual(hex(ours), hex(theirs))
})

test('rejects off-curve and malformed public keys', () => {
  const { pub } = nodeKeyPair()

  const tampered = new Uint8Array(pub)
  tampered[40] ^= 0x01
  assert.strictEqual(decodePublicKey(tampered), null, 'off-curve point accepted')

  assert.strictEqual(decodePublicKey(pub.subarray(0, 64)), null, 'short key accepted')

  const badPrefix = new Uint8Array(pub)
  badPrefix[0] = 0x02
  assert.strictEqual(decodePublicKey(badPrefix), null, 'compressed prefix accepted')

  const allFf = new Uint8Array(65)
  allFf[0] = 0x04
  allFf.fill(0xff, 1)
  assert.strictEqual(decodePublicKey(allFf), null, 'out-of-range coordinates accepted')

  assert.strictEqual(ecdh(new Uint8Array(32).fill(1), tampered), null, 'ecdh used an invalid peer key')
})

test('private key validation honours the group order', () => {
  assert.ok(!isValidPrivateKey(new Uint8Array(32)), 'zero accepted')

  const order = Buffer.from('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551', 'hex')
  assert.ok(!isValidPrivateKey(new Uint8Array(order)), 'n accepted')

  const belowOrder = new Uint8Array(order)
  belowOrder[31] -= 1
  assert.ok(isValidPrivateKey(belowOrder), 'n-1 rejected')
})

test('scalar multiplication cost is within a watch budget', () => {
  const priv = generatePrivateKey((n) => new Uint8Array(crypto.randomBytes(n)))
  const started = process.hrtime.bigint()
  derivePublicKey(priv)
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  console.log(`      scalar multiplication: ${ms.toFixed(1)} ms on desktop`)
  assert.ok(ms < 2000, `unexpectedly slow: ${ms} ms`)
})
