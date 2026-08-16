// SHA-1 (RFC 3174).
//
// Needed in two places by the Tesla BLE protocol: deriving a vehicle's
// advertised BLE name from its VIN, and deriving the session key from the
// ECDH shared secret.
//
// Restricted to 32-bit integer math and plain TypedArray indexing so the same
// source runs on the watch, where there is no crypto module and no guarantee
// of BigInt.

export function sha1 (bytes) {
  const len = bytes.length
  const blocks = Math.ceil((len + 9) / 64)
  const buf = new Uint8Array(blocks * 64)
  buf.set(bytes)
  buf[len] = 0x80

  const bits = len * 8
  const end = buf.length
  buf[end - 8] = Math.floor(bits / 72057594037927936) & 0xff
  buf[end - 7] = Math.floor(bits / 281474976710656) & 0xff
  buf[end - 6] = Math.floor(bits / 1099511627776) & 0xff
  buf[end - 5] = Math.floor(bits / 4294967296) & 0xff
  buf[end - 4] = (bits >>> 24) & 0xff
  buf[end - 3] = (bits >>> 16) & 0xff
  buf[end - 2] = (bits >>> 8) & 0xff
  buf[end - 1] = bits & 0xff

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0

  const w = new Int32Array(80)

  for (let off = 0; off < end; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4
      w[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3]
    }
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]
      w[i] = (x << 1) | (x >>> 31)
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4

    for (let i = 0; i < 80; i++) {
      let f, k
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0
      e = d
      d = c
      c = (b << 30) | (b >>> 2)
      b = a
      a = t
    }

    h0 = (h0 + a) | 0
    h1 = (h1 + b) | 0
    h2 = (h2 + c) | 0
    h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0
  }

  const out = new Uint8Array(20)
  const hs = [h0, h1, h2, h3, h4]
  for (let i = 0; i < 5; i++) {
    out[i * 4] = (hs[i] >>> 24) & 0xff
    out[i * 4 + 1] = (hs[i] >>> 16) & 0xff
    out[i * 4 + 2] = (hs[i] >>> 8) & 0xff
    out[i * 4 + 3] = hs[i] & 0xff
  }
  return out
}
