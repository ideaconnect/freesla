// AES block cipher, encryption direction only.
//
// GCM builds both its keystream and its authentication tag out of forward
// block encryptions, so the inverse cipher is dead weight on a watch and is
// deliberately absent.

const SBOX = new Uint8Array(256)

function rotl8 (x, s) {
  return ((x << s) | (x >>> (8 - s))) & 0xff
}

;(function initSbox () {
  let p = 1
  let q = 1
  do {
    p = (p ^ (p << 1) ^ ((p & 0x80) ? 0x1b : 0)) & 0xff
    q = (q ^ (q << 1)) & 0xff
    q = (q ^ (q << 2)) & 0xff
    q = (q ^ (q << 4)) & 0xff
    if (q & 0x80) q = (q ^ 0x09) & 0xff
    SBOX[p] = (q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63) & 0xff
  } while (p !== 1)
  SBOX[0] = 0x63
})()

function xtime (x) {
  return ((x << 1) ^ ((x & 0x80) ? 0x1b : 0)) & 0xff
}

// Expands a 16/24/32-byte key into the round-key schedule used by encryptBlock.
export function expandKey (key) {
  const nk = key.length >>> 2
  if (nk !== 4 && nk !== 6 && nk !== 8) throw new Error('aes: bad key length')
  const nr = nk + 6
  const words = 4 * (nr + 1)
  const rk = new Uint8Array(words * 4)
  rk.set(key)

  let rcon = 1
  for (let i = nk; i < words; i++) {
    const o = i * 4
    let t0 = rk[o - 4]
    let t1 = rk[o - 3]
    let t2 = rk[o - 2]
    let t3 = rk[o - 1]

    if (i % nk === 0) {
      const tmp = t0
      t0 = SBOX[t1] ^ rcon
      t1 = SBOX[t2]
      t2 = SBOX[t3]
      t3 = SBOX[tmp]
      rcon = xtime(rcon)
    } else if (nk > 6 && i % nk === 4) {
      t0 = SBOX[t0]
      t1 = SBOX[t1]
      t2 = SBOX[t2]
      t3 = SBOX[t3]
    }

    const p = o - nk * 4
    rk[o] = rk[p] ^ t0
    rk[o + 1] = rk[p + 1] ^ t1
    rk[o + 2] = rk[p + 2] ^ t2
    rk[o + 3] = rk[p + 3] ^ t3
  }

  return { rk, nr }
}

// Encrypts the 16 bytes of `state` in place.
export function encryptBlock (schedule, state) {
  const rk = schedule.rk
  const nr = schedule.nr

  for (let i = 0; i < 16; i++) state[i] ^= rk[i]

  for (let round = 1; round <= nr; round++) {
    for (let i = 0; i < 16; i++) state[i] = SBOX[state[i]]

    // ShiftRows: row r rotates left by r. State is column-major.
    let t = state[1]
    state[1] = state[5]; state[5] = state[9]; state[9] = state[13]; state[13] = t
    t = state[2]; state[2] = state[10]; state[10] = t
    t = state[6]; state[6] = state[14]; state[14] = t
    t = state[15]
    state[15] = state[11]; state[11] = state[7]; state[7] = state[3]; state[3] = t

    if (round !== nr) {
      for (let c = 0; c < 16; c += 4) {
        const a0 = state[c], a1 = state[c + 1], a2 = state[c + 2], a3 = state[c + 3]
        const all = a0 ^ a1 ^ a2 ^ a3
        state[c] = a0 ^ all ^ xtime(a0 ^ a1)
        state[c + 1] = a1 ^ all ^ xtime(a1 ^ a2)
        state[c + 2] = a2 ^ all ^ xtime(a2 ^ a3)
        state[c + 3] = a3 ^ all ^ xtime(a3 ^ a0)
      }
    }

    const o = round * 16
    for (let i = 0; i < 16; i++) state[i] ^= rk[o + i]
  }
}
