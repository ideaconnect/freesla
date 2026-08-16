// AES-GCM (NIST SP 800-38D).
//
// GHASH uses the plain shift-and-xor field multiplication rather than a
// windowed table: Tesla command payloads are on the order of a hundred bytes,
// so the table would cost more RAM than the loop costs time.

import { expandKey, encryptBlock } from './aes.js'

function ghashMul (xw, yw, out) {
  let z0 = 0, z1 = 0, z2 = 0, z3 = 0
  let v0 = yw[0], v1 = yw[1], v2 = yw[2], v3 = yw[3]

  for (let i = 0; i < 128; i++) {
    if ((xw[i >>> 5] >>> (31 - (i & 31))) & 1) {
      z0 ^= v0; z1 ^= v1; z2 ^= v2; z3 ^= v3
    }
    const lsb = v3 & 1
    v3 = ((v3 >>> 1) | (v2 << 31)) >>> 0
    v2 = ((v2 >>> 1) | (v1 << 31)) >>> 0
    v1 = ((v1 >>> 1) | (v0 << 31)) >>> 0
    v0 = v0 >>> 1
    if (lsb) v0 = (v0 ^ 0xe1000000) >>> 0
  }

  out[0] = z0 >>> 0; out[1] = z1 >>> 0; out[2] = z2 >>> 0; out[3] = z3 >>> 0
}

function bytesToWords (bytes, off, words) {
  for (let i = 0; i < 4; i++) {
    const j = off + i * 4
    words[i] = (((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3])) >>> 0
  }
}

class Ghash {
  constructor (h) {
    this.h = new Uint32Array(4)
    bytesToWords(h, 0, this.h)
    this.y = new Uint32Array(4)
    this.tmp = new Uint32Array(4)
  }

  // Absorbs `data` zero-padded up to a multiple of the 16-byte block size.
  update (data) {
    const blocks = Math.ceil(data.length / 16)
    for (let b = 0; b < blocks; b++) {
      const off = b * 16
      for (let i = 0; i < 4; i++) {
        const j = off + i * 4
        const w = (((j < data.length ? data[j] : 0) << 24) |
                   ((j + 1 < data.length ? data[j + 1] : 0) << 16) |
                   ((j + 2 < data.length ? data[j + 2] : 0) << 8) |
                   (j + 3 < data.length ? data[j + 3] : 0)) >>> 0
        this.y[i] = (this.y[i] ^ w) >>> 0
      }
      ghashMul(this.y, this.h, this.tmp)
      this.y.set(this.tmp)
    }
  }

  updateLengths (aadLen, dataLen) {
    const block = new Uint8Array(16)
    writeUint64BE(block, 0, aadLen * 8)
    writeUint64BE(block, 8, dataLen * 8)
    this.update(block)
  }

  digest () {
    const out = new Uint8Array(16)
    for (let i = 0; i < 4; i++) {
      out[i * 4] = (this.y[i] >>> 24) & 0xff
      out[i * 4 + 1] = (this.y[i] >>> 16) & 0xff
      out[i * 4 + 2] = (this.y[i] >>> 8) & 0xff
      out[i * 4 + 3] = this.y[i] & 0xff
    }
    return out
  }
}

function writeUint64BE (buf, off, value) {
  buf[off] = Math.floor(value / 72057594037927936) & 0xff
  buf[off + 1] = Math.floor(value / 281474976710656) & 0xff
  buf[off + 2] = Math.floor(value / 1099511627776) & 0xff
  buf[off + 3] = Math.floor(value / 4294967296) & 0xff
  buf[off + 4] = (value >>> 24) & 0xff
  buf[off + 5] = (value >>> 16) & 0xff
  buf[off + 6] = (value >>> 8) & 0xff
  buf[off + 7] = value & 0xff
}

function inc32 (block) {
  for (let i = 15; i >= 12; i--) {
    block[i] = (block[i] + 1) & 0xff
    if (block[i] !== 0) break
  }
}

function computeJ0 (ghash, iv) {
  if (iv.length === 12) {
    const j0 = new Uint8Array(16)
    j0.set(iv)
    j0[15] = 1
    return j0
  }
  ghash.update(iv)
  ghash.updateLengths(0, iv.length)
  const j0 = ghash.digest()
  ghash.y.fill(0)
  return j0
}

// XOR-in-place of the AES-CTR keystream, shared by encrypt and decrypt.
function gctr (schedule, icb, data) {
  const out = new Uint8Array(data.length)
  const counter = new Uint8Array(icb)
  const keystream = new Uint8Array(16)

  for (let off = 0; off < data.length; off += 16) {
    keystream.set(counter)
    encryptBlock(schedule, keystream)
    const n = Math.min(16, data.length - off)
    for (let i = 0; i < n; i++) out[off + i] = data[off + i] ^ keystream[i]
    inc32(counter)
  }
  return out
}

function computeTag (schedule, ghash, j0, aad, ciphertext, tagLength) {
  ghash.update(aad)
  ghash.update(ciphertext)
  ghash.updateLengths(aad.length, ciphertext.length)
  const s = ghash.digest()

  const ek = new Uint8Array(j0)
  encryptBlock(schedule, ek)

  const tag = new Uint8Array(tagLength)
  for (let i = 0; i < tagLength; i++) tag[i] = s[i] ^ ek[i]
  return tag
}

export function gcmEncrypt (key, iv, plaintext, aad, tagLength) {
  if (!aad) aad = new Uint8Array(0)
  if (!tagLength) tagLength = 16

  const schedule = expandKey(key)
  const h = new Uint8Array(16)
  encryptBlock(schedule, h)

  const ghash = new Ghash(h)
  const j0 = computeJ0(ghash, iv)

  const icb = new Uint8Array(j0)
  inc32(icb)
  const ciphertext = gctr(schedule, icb, plaintext)

  return { ciphertext, tag: computeTag(schedule, ghash, j0, aad, ciphertext, tagLength) }
}

// Returns the plaintext, or null when the tag does not verify.
export function gcmDecrypt (key, iv, ciphertext, aad, tag) {
  if (!aad) aad = new Uint8Array(0)

  const schedule = expandKey(key)
  const h = new Uint8Array(16)
  encryptBlock(schedule, h)

  const ghash = new Ghash(h)
  const j0 = computeJ0(ghash, iv)
  const expected = computeTag(schedule, ghash, j0, aad, ciphertext, tag.length)

  let diff = 0
  for (let i = 0; i < tag.length; i++) diff |= expected[i] ^ tag[i]
  if (diff !== 0) return null

  const icb = new Uint8Array(j0)
  inc32(icb)
  return gctr(schedule, icb, ciphertext)
}
