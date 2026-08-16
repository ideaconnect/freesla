// SHA-256 and HMAC-SHA-256 (FIPS 180-4, RFC 2104).
//
// The Tesla protocol uses HMAC-SHA-256 both to derive the per-vehicle signing
// key from the ECDH shared secret and to authenticate each command.

const K = new Int32Array([
  0x428a2f98 | 0, 0x71374491 | 0, 0xb5c0fbcf | 0, 0xe9b5dba5 | 0,
  0x3956c25b | 0, 0x59f111f1 | 0, 0x923f82a4 | 0, 0xab1c5ed5 | 0,
  0xd807aa98 | 0, 0x12835b01 | 0, 0x243185be | 0, 0x550c7dc3 | 0,
  0x72be5d74 | 0, 0x80deb1fe | 0, 0x9bdc06a7 | 0, 0xc19bf174 | 0,
  0xe49b69c1 | 0, 0xefbe4786 | 0, 0x0fc19dc6 | 0, 0x240ca1cc | 0,
  0x2de92c6f | 0, 0x4a7484aa | 0, 0x5cb0a9dc | 0, 0x76f988da | 0,
  0x983e5152 | 0, 0xa831c66d | 0, 0xb00327c8 | 0, 0xbf597fc7 | 0,
  0xc6e00bf3 | 0, 0xd5a79147 | 0, 0x06ca6351 | 0, 0x14292967 | 0,
  0x27b70a85 | 0, 0x2e1b2138 | 0, 0x4d2c6dfc | 0, 0x53380d13 | 0,
  0x650a7354 | 0, 0x766a0abb | 0, 0x81c2c92e | 0, 0x92722c85 | 0,
  0xa2bfe8a1 | 0, 0xa81a664b | 0, 0xc24b8b70 | 0, 0xc76c51a3 | 0,
  0xd192e819 | 0, 0xd6990624 | 0, 0xf40e3585 | 0, 0x106aa070 | 0,
  0x19a4c116 | 0, 0x1e376c08 | 0, 0x2748774c | 0, 0x34b0bcb5 | 0,
  0x391c0cb3 | 0, 0x4ed8aa4a | 0, 0x5b9cca4f | 0, 0x682e6ff3 | 0,
  0x748f82ee | 0, 0x78a5636f | 0, 0x84c87814 | 0, 0x8cc70208 | 0,
  0x90befffa | 0, 0xa4506ceb | 0, 0xbef9a3f7 | 0, 0xc67178f2 | 0
])

export function sha256 (bytes) {
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

  const h = new Int32Array([
    0x6a09e667 | 0, 0xbb67ae85 | 0, 0x3c6ef372 | 0, 0xa54ff53a | 0,
    0x510e527f | 0, 0x9b05688c | 0, 0x1f83d9ab | 0, 0x5be0cd19 | 0
  ])
  const w = new Int32Array(64)

  for (let off = 0; off < end; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4
      w[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3]
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]
      const y = w[i - 2]
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }

    let a = h[0], b = h[1], c = h[2], d = h[3]
    let e = h[4], f = h[5], g = h[6], hh = h[7]

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      hh = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }

    h[0] = (h[0] + a) | 0
    h[1] = (h[1] + b) | 0
    h[2] = (h[2] + c) | 0
    h[3] = (h[3] + d) | 0
    h[4] = (h[4] + e) | 0
    h[5] = (h[5] + f) | 0
    h[6] = (h[6] + g) | 0
    h[7] = (h[7] + hh) | 0
  }

  const out = new Uint8Array(32)
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (h[i] >>> 24) & 0xff
    out[i * 4 + 1] = (h[i] >>> 16) & 0xff
    out[i * 4 + 2] = (h[i] >>> 8) & 0xff
    out[i * 4 + 3] = h[i] & 0xff
  }
  return out
}

export function hmacSha256 (key, message) {
  let k = key
  if (k.length > 64) k = sha256(k)

  const ipad = new Uint8Array(64 + message.length)
  const opad = new Uint8Array(64 + 32)
  for (let i = 0; i < 64; i++) {
    const b = i < k.length ? k[i] : 0
    ipad[i] = b ^ 0x36
    opad[i] = b ^ 0x5c
  }
  ipad.set(message, 64)
  opad.set(sha256(ipad), 64)
  return sha256(opad)
}
