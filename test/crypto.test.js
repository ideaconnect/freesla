// Validates the hand-rolled primitives against Node's crypto, which stands in
// for the reference implementation the watch does not have.

import { test } from 'node:test'
import assert from 'node:assert'
import crypto from 'node:crypto'

import { sha1 } from '../lib/crypto/sha1.js'
import { sha256, hmacSha256 } from '../lib/crypto/sha256.js'
import { expandKey, encryptBlock } from '../lib/crypto/aes.js'
import { gcmEncrypt, gcmDecrypt } from '../lib/crypto/gcm.js'

const SIZES = [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 200, 1000]

function randomBytes (n) {
  return new Uint8Array(crypto.randomBytes(n))
}

function hex (u8) {
  return Buffer.from(u8).toString('hex')
}

test('sha1 matches node for many lengths', () => {
  for (const n of SIZES) {
    const input = randomBytes(n)
    const expected = crypto.createHash('sha1').update(Buffer.from(input)).digest('hex')
    assert.strictEqual(hex(sha1(input)), expected, `length ${n}`)
  }
})

test('sha1 known vector', () => {
  const abc = new Uint8Array([0x61, 0x62, 0x63])
  assert.strictEqual(hex(sha1(abc)), 'a9993e364706816aba3e25717850c26c9cd0d89d')
})

test('sha256 matches node for many lengths', () => {
  for (const n of SIZES) {
    const input = randomBytes(n)
    const expected = crypto.createHash('sha256').update(Buffer.from(input)).digest('hex')
    assert.strictEqual(hex(sha256(input)), expected, `length ${n}`)
  }
})

test('hmac-sha256 matches node across key and message sizes', () => {
  for (const keyLen of [1, 16, 32, 64, 65, 100]) {
    for (const msgLen of [0, 1, 32, 64, 200]) {
      const key = randomBytes(keyLen)
      const msg = randomBytes(msgLen)
      const expected = crypto.createHmac('sha256', Buffer.from(key))
        .update(Buffer.from(msg)).digest('hex')
      assert.strictEqual(hex(hmacSha256(key, msg)), expected, `key ${keyLen} msg ${msgLen}`)
    }
  }
})

test('aes raw block encryption matches node ecb', () => {
  for (const keyLen of [16, 24, 32]) {
    for (let trial = 0; trial < 20; trial++) {
      const key = randomBytes(keyLen)
      const block = randomBytes(16)

      const cipher = crypto.createCipheriv(`aes-${keyLen * 8}-ecb`, Buffer.from(key), null)
      cipher.setAutoPadding(false)
      const expected = Buffer.concat([cipher.update(Buffer.from(block)), cipher.final()])

      const state = new Uint8Array(block)
      encryptBlock(expandKey(key), state)
      assert.strictEqual(hex(state), expected.toString('hex'), `aes-${keyLen * 8}`)
    }
  }
})

test('aes-gcm encryption matches node', () => {
  for (const keyLen of [16, 32]) {
    for (const ptLen of [0, 1, 15, 16, 17, 64, 100, 255]) {
      for (const aadLen of [0, 1, 16, 40]) {
        const key = randomBytes(keyLen)
        const iv = randomBytes(12)
        const pt = randomBytes(ptLen)
        const aad = randomBytes(aadLen)

        const cipher = crypto.createCipheriv(`aes-${keyLen * 8}-gcm`, Buffer.from(key), Buffer.from(iv))
        cipher.setAAD(Buffer.from(aad))
        const expectedCt = Buffer.concat([cipher.update(Buffer.from(pt)), cipher.final()])
        const expectedTag = cipher.getAuthTag()

        const got = gcmEncrypt(key, iv, pt, aad)
        const label = `key ${keyLen} pt ${ptLen} aad ${aadLen}`
        assert.strictEqual(hex(got.ciphertext), expectedCt.toString('hex'), `ct ${label}`)
        assert.strictEqual(hex(got.tag), expectedTag.toString('hex'), `tag ${label}`)
      }
    }
  }
})

test('aes-gcm accepts a non-12-byte iv', () => {
  for (const ivLen of [8, 16, 32]) {
    const key = randomBytes(16)
    const iv = randomBytes(ivLen)
    const pt = randomBytes(50)
    const aad = randomBytes(16)

    const cipher = crypto.createCipheriv('aes-128-gcm', Buffer.from(key), Buffer.from(iv), { authTagLength: 16 })
    cipher.setAAD(Buffer.from(aad))
    const expectedCt = Buffer.concat([cipher.update(Buffer.from(pt)), cipher.final()])
    const expectedTag = cipher.getAuthTag()

    const got = gcmEncrypt(key, iv, pt, aad)
    assert.strictEqual(hex(got.ciphertext), expectedCt.toString('hex'), `iv ${ivLen}`)
    assert.strictEqual(hex(got.tag), expectedTag.toString('hex'), `iv ${ivLen} tag`)
  }
})

test('aes-gcm supports truncated tags', () => {
  const key = randomBytes(16)
  const iv = randomBytes(12)
  const pt = randomBytes(30)
  const aad = randomBytes(8)

  const cipher = crypto.createCipheriv('aes-128-gcm', Buffer.from(key), Buffer.from(iv), { authTagLength: 8 })
  cipher.setAAD(Buffer.from(aad))
  const expectedCt = Buffer.concat([cipher.update(Buffer.from(pt)), cipher.final()])
  const expectedTag = cipher.getAuthTag()

  const got = gcmEncrypt(key, iv, pt, aad, 8)
  assert.strictEqual(hex(got.ciphertext), expectedCt.toString('hex'))
  assert.strictEqual(hex(got.tag), expectedTag.toString('hex'))
})

test('aes-gcm round trips and rejects tampering', () => {
  const key = randomBytes(16)
  const iv = randomBytes(12)
  const pt = randomBytes(80)
  const aad = randomBytes(20)

  const { ciphertext, tag } = gcmEncrypt(key, iv, pt, aad)
  assert.strictEqual(hex(gcmDecrypt(key, iv, ciphertext, aad, tag)), hex(pt))

  const badCt = new Uint8Array(ciphertext)
  badCt[5] ^= 1
  assert.strictEqual(gcmDecrypt(key, iv, badCt, aad, tag), null, 'ciphertext tamper')

  const badAad = new Uint8Array(aad)
  badAad[0] ^= 1
  assert.strictEqual(gcmDecrypt(key, iv, ciphertext, badAad, tag), null, 'aad tamper')

  const badTag = new Uint8Array(tag)
  badTag[15] ^= 1
  assert.strictEqual(gcmDecrypt(key, iv, ciphertext, aad, badTag), null, 'tag tamper')
})
