// NIST P-256 (secp256r1) key generation and ECDH.
//
// This is the piece Zepp OS gives you nothing for, and the reason a watch-side
// Tesla key was long considered impractical. Two constraints shape the whole
// file:
//
//   * No BigInt. The watch runtime cannot be relied on to have it, so field
//     elements are 16 x 16-bit limbs, little-endian. A limb product is under
//     2^32 and a full column of them stays under 2^53, which is exactly the
//     range a double represents without loss.
//   * No garbage. Scratch space is allocated once at module scope; a scalar
//     multiplication runs thousands of field operations and allocating per
//     operation would thrash a watch heap.
//
// Cost is roughly 3-4k field multiplications per scalar multiplication: ~14ms
// in a phone's JS engine and ~87 seconds on the watch's interpreter. Zepp OS
// offers nothing native to fall back on -- its twenty-one modules include no
// crypto of any kind -- so the answer is not to make this faster but to run it
// somewhere else.
//
// Nothing on the watch calls into the curve arithmetic here. Both uses are
// one-time setup and both happen on the phone: generating the keypair, and
// deriving the ECDH shared secret on first contact with a car. The watch
// imports this file only for the cheap checks -- isValidPrivateKey and
// decodePublicKey -- and spends its keys on AES-GCM and HMAC, which cost
// microseconds.

const LIMBS = 16
const MASK = 0xffff

const P_HEX = 'ffffffff00000001000000000000000000000000ffffffffffffffffffffffff'
const N_HEX = 'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'
const B_HEX = '5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b'
const GX_HEX = '6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'
const GY_HEX = '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5'

function newLimbs () {
  return new Uint16Array(LIMBS)
}

function hexToBytes (hex) {
  const out = new Uint8Array(hex.length >>> 1)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return out
}

// Big-endian bytes in, little-endian limbs out.
export function bytesToLimbs (bytes) {
  const out = newLimbs()
  const n = bytes.length
  for (let i = 0; i < LIMBS; i++) {
    const lo = n - 1 - i * 2
    const hi = lo - 1
    out[i] = (lo >= 0 ? bytes[lo] : 0) | ((hi >= 0 ? bytes[hi] : 0) << 8)
  }
  return out
}

export function limbsToBytes (limbs) {
  const out = new Uint8Array(32)
  for (let i = 0; i < LIMBS; i++) {
    out[31 - i * 2] = limbs[i] & 0xff
    out[30 - i * 2] = (limbs[i] >>> 8) & 0xff
  }
  return out
}

function copy (dst, src) {
  for (let i = 0; i < LIMBS; i++) dst[i] = src[i]
}

function isZero (a) {
  let acc = 0
  for (let i = 0; i < LIMBS; i++) acc |= a[i]
  return acc === 0
}

function equals (a, b) {
  let diff = 0
  for (let i = 0; i < LIMBS; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

// Returns 1 when a >= b.
function geq (a, b) {
  for (let i = LIMBS - 1; i >= 0; i--) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : 0
  }
  return 1
}

// out = a - b, returning the final borrow.
function subRaw (a, b, out) {
  let borrow = 0
  for (let i = 0; i < LIMBS; i++) {
    const d = a[i] - b[i] - borrow
    out[i] = d & MASK
    borrow = d < 0 ? 1 : 0
  }
  return borrow
}

// out = a + b, returning the carry out of the top limb.
function addRaw (a, b, out) {
  let carry = 0
  for (let i = 0; i < LIMBS; i++) {
    const s = a[i] + b[i] + carry
    out[i] = s & MASK
    carry = s >>> 16
  }
  return carry
}

const P = bytesToLimbs(hexToBytes(P_HEX))
const N = bytesToLimbs(hexToBytes(N_HEX))

function addMod (a, b, m, out) {
  const carry = addRaw(a, b, out)
  if (carry || geq(out, m)) subRaw(out, m, out)
}

function subMod (a, b, m, out) {
  const borrow = subRaw(a, b, out)
  if (borrow) addRaw(out, m, out)
}

// -m^-1 mod 2^16, the Montgomery reduction constant for 16-bit limbs.
function montInverseWord (m0) {
  let inv = 1
  for (let k = 0; k < 5; k++) {
    inv = (inv * (2 - ((m0 * inv) & MASK))) & MASK
  }
  return (-inv) & MASK
}

function makeContext (m) {
  const ctx = {
    m,
    n0: montInverseWord(m[0]),
    rr: newLimbs(),
    one: newLimbs(),
    oneMont: newLimbs()
  }
  ctx.one[0] = 1

  // rr = 2^512 mod m, reached by doubling 1 a total of 512 times. Cheap at
  // load time and avoids hardcoding a constant that could be mistranscribed.
  const acc = newLimbs()
  acc[0] = 1
  for (let i = 0; i < 512; i++) addMod(acc, acc, m, acc)
  copy(ctx.rr, acc)

  // Montgomery form of 1 is 2^256 mod m: halve rr's exponent by reducing once.
  montMul(ctx, ctx.rr, ctx.one, ctx.oneMont)
  return ctx
}

const T = new Float64Array(LIMBS + 2)

// Montgomery multiplication, CIOS. out = a*b*R^-1 mod m.
function montMul (ctx, a, b, out) {
  const m = ctx.m
  const n0 = ctx.n0

  for (let i = 0; i < LIMBS + 2; i++) T[i] = 0

  for (let i = 0; i < LIMBS; i++) {
    const bi = b[i]
    let carry = 0
    for (let j = 0; j < LIMBS; j++) {
      const sum = T[j] + a[j] * bi + carry
      T[j] = sum & MASK
      carry = Math.floor(sum / 65536)
    }
    let sum = T[LIMBS] + carry
    T[LIMBS] = sum & MASK
    T[LIMBS + 1] = Math.floor(sum / 65536)

    const u = (T[0] * n0) & MASK
    carry = Math.floor((T[0] + u * m[0]) / 65536)
    for (let j = 1; j < LIMBS; j++) {
      sum = T[j] + u * m[j] + carry
      T[j - 1] = sum & MASK
      carry = Math.floor(sum / 65536)
    }
    sum = T[LIMBS] + carry
    T[LIMBS - 1] = sum & MASK
    T[LIMBS] = T[LIMBS + 1] + Math.floor(sum / 65536)
  }

  let borrow = 0
  for (let i = 0; i < LIMBS; i++) {
    const d = T[i] - m[i] - borrow
    out[i] = d & MASK
    borrow = d < 0 ? 1 : 0
  }
  // The subtraction was speculative; undo it when T was already reduced.
  if (T[LIMBS] - borrow < 0) {
    for (let i = 0; i < LIMBS; i++) out[i] = T[i]
  }
}

const FP = makeContext(P)
const FN = makeContext(N)

function toMont (ctx, a, out) {
  montMul(ctx, a, ctx.rr, out)
}

function fromMont (ctx, a, out) {
  montMul(ctx, a, ctx.one, out)
}

// Modular inverse via Fermat: a^(m-2) mod m. Square-and-multiply over the
// exponent's bits, which keeps this to ~380 field multiplications and avoids a
// separate extended-Euclid implementation.
function montInvert (ctx, a, out) {
  const exp = newLimbs()
  const two = newLimbs()
  two[0] = 2
  subRaw(ctx.m, two, exp)

  const result = newLimbs()
  copy(result, ctx.oneMont)
  const base = newLimbs()
  copy(base, a)
  const tmp = newLimbs()

  for (let i = 0; i < 256; i++) {
    if ((exp[i >>> 4] >>> (i & 15)) & 1) {
      montMul(ctx, result, base, tmp)
      copy(result, tmp)
    }
    montMul(ctx, base, base, tmp)
    copy(base, tmp)
  }
  copy(out, result)
}

// --- Curve arithmetic, Jacobian coordinates, all values in Montgomery form ---

function newPoint () {
  return { x: newLimbs(), y: newLimbs(), z: newLimbs() }
}

function pointCopy (dst, src) {
  copy(dst.x, src.x)
  copy(dst.y, src.y)
  copy(dst.z, src.z)
}

function isInfinity (p) {
  return isZero(p.z)
}

const t1 = newLimbs(), t2 = newLimbs(), t3 = newLimbs(), t4 = newLimbs()
const t5 = newLimbs(), t6 = newLimbs(), t7 = newLimbs()

function fadd (a, b, out) { addMod(a, b, P, out) }
function fsub (a, b, out) { subMod(a, b, P, out) }
function fmul (a, b, out) { montMul(FP, a, b, out) }

// dbl-2001-b, which is valid because P-256 has a = -3.
function pointDouble (out, p) {
  if (isInfinity(p)) {
    pointCopy(out, p)
    return
  }

  fmul(p.z, p.z, t1)            // delta = Z^2
  fmul(p.y, p.y, t2)            // gamma = Y^2
  fmul(p.x, t2, t3)             // beta  = X*gamma

  fsub(p.x, t1, t4)             // X-delta
  fadd(p.x, t1, t5)             // X+delta
  fmul(t4, t5, t6)
  fadd(t6, t6, t4)
  fadd(t4, t6, t4)              // alpha = 3*(X-delta)*(X+delta)

  fadd(p.y, p.z, t5)
  fmul(t5, t5, t5)
  fsub(t5, t2, t5)
  fsub(t5, t1, t5)              // Z3 = (Y+Z)^2 - gamma - delta

  fmul(t4, t4, t6)              // alpha^2
  fadd(t3, t3, t7)
  fadd(t7, t7, t7)              // 4*beta
  fadd(t7, t7, t1)              // 8*beta
  fsub(t6, t1, t6)              // X3 = alpha^2 - 8*beta

  fsub(t7, t6, t1)              // 4*beta - X3
  fmul(t4, t1, t1)
  fmul(t2, t2, t3)              // gamma^2
  fadd(t3, t3, t3)
  fadd(t3, t3, t3)
  fadd(t3, t3, t3)              // 8*gamma^2
  fsub(t1, t3, t1)              // Y3

  copy(out.x, t6)
  copy(out.y, t1)
  copy(out.z, t5)
}

const a1 = newLimbs(), a2 = newLimbs(), a3 = newLimbs(), a4 = newLimbs()
const a5 = newLimbs(), a6 = newLimbs(), a7 = newLimbs(), a8 = newLimbs()

// add-2007-bl, with the degenerate cases handled explicitly.
function pointAdd (out, p, q) {
  if (isInfinity(p)) { pointCopy(out, q); return }
  if (isInfinity(q)) { pointCopy(out, p); return }

  fmul(p.z, p.z, a1)            // Z1Z1
  fmul(q.z, q.z, a2)            // Z2Z2
  fmul(p.x, a2, a3)             // U1 = X1*Z2Z2
  fmul(q.x, a1, a4)             // U2 = X2*Z1Z1

  fmul(p.y, q.z, a5)
  fmul(a5, a2, a5)              // S1 = Y1*Z2*Z2Z2
  fmul(q.y, p.z, a6)
  fmul(a6, a1, a6)              // S2 = Y2*Z1*Z1Z1

  fsub(a4, a3, a7)              // H = U2-U1
  fsub(a6, a5, a8)              // S2-S1

  if (isZero(a7)) {
    if (isZero(a8)) {
      pointDouble(out, p)
    } else {
      for (let i = 0; i < LIMBS; i++) { out.x[i] = 0; out.y[i] = 0; out.z[i] = 0 }
      out.x[0] = 1
      out.y[0] = 1
    }
    return
  }

  fadd(a8, a8, a8)              // r = 2*(S2-S1)

  fadd(a7, a7, t1)
  fmul(t1, t1, t1)              // I = (2H)^2
  fmul(a7, t1, t2)              // J = H*I
  fmul(a3, t1, t3)              // V = U1*I

  fmul(a8, a8, t4)
  fsub(t4, t2, t4)
  fadd(t3, t3, t5)
  fsub(t4, t5, t4)              // X3 = r^2 - J - 2V

  fsub(t3, t4, t5)
  fmul(a8, t5, t5)
  fmul(a5, t2, t6)
  fadd(t6, t6, t6)
  fsub(t5, t6, t5)              // Y3 = r*(V-X3) - 2*S1*J

  fadd(p.z, q.z, t6)
  fmul(t6, t6, t6)
  fsub(t6, a1, t6)
  fsub(t6, a2, t6)
  fmul(t6, a7, t6)              // Z3 = ((Z1+Z2)^2 - Z1Z1 - Z2Z2)*H

  copy(out.x, t4)
  copy(out.y, t5)
  copy(out.z, t6)
}

const accum = newPoint()
const sum = newPoint()

// Double-and-add-always. The dummy add costs 2x but keeps the loop's shape
// independent of the scalar's bits.
//
// There is no sliced or resumable variant, and that absence is deliberate.
// This runs about 14ms here and about 87 seconds on the Zepp interpreter --
// the interpreter, not the algorithm -- and an earlier attempt to make the
// watch affordable by spreading it over timer ticks was solving the wrong
// problem. Both callers of this are one-time setup work, so both now happen on
// the phone: the keypair at pairing, the ECDH shared secret at first contact
// with a car. Nothing in the watch's path reaches this function.
function scalarMult (scalarBytes, point) {
  for (let i = 0; i < LIMBS; i++) { accum.x[i] = 0; accum.y[i] = 0; accum.z[i] = 0 }

  for (let byteIndex = 0; byteIndex < 32; byteIndex++) {
    const byte = scalarBytes[byteIndex]
    for (let bit = 7; bit >= 0; bit--) {
      pointDouble(accum, accum)
      pointAdd(sum, accum, point)
      if ((byte >>> bit) & 1) pointCopy(accum, sum)
    }
  }

  const result = newPoint()
  pointCopy(result, accum)
  return result
}

// Jacobian (X, Y, Z) -> affine (x, y) = (X/Z^2, Y/Z^3), leaving Montgomery form.
function toAffine (p) {
  if (isInfinity(p)) return null

  const zInv = newLimbs()
  const zInv2 = newLimbs()
  const zInv3 = newLimbs()
  montInvert(FP, p.z, zInv)
  fmul(zInv, zInv, zInv2)
  fmul(zInv2, zInv, zInv3)

  const x = newLimbs()
  const y = newLimbs()
  fmul(p.x, zInv2, x)
  fmul(p.y, zInv3, y)

  const xn = newLimbs()
  const yn = newLimbs()
  fromMont(FP, x, xn)
  fromMont(FP, y, yn)
  return { x: xn, y: yn }
}

const B_MONT = (function () {
  const b = bytesToLimbs(hexToBytes(B_HEX))
  const out = newLimbs()
  toMont(FP, b, out)
  return out
})()

const G = (function () {
  const p = newPoint()
  toMont(FP, bytesToLimbs(hexToBytes(GX_HEX)), p.x)
  toMont(FP, bytesToLimbs(hexToBytes(GY_HEX)), p.y)
  copy(p.z, FP.oneMont)
  return p
})()

// Confirms y^2 == x^3 - 3x + b. Skipping this on an attacker-supplied point
// would expose the private key to an invalid-curve attack.
function isOnCurve (xMont, yMont) {
  const lhs = newLimbs()
  fmul(yMont, yMont, lhs)

  const rhs = newLimbs()
  fmul(xMont, xMont, rhs)
  fmul(rhs, xMont, rhs)

  const three = newLimbs()
  const threeMont = newLimbs()
  three[0] = 3
  toMont(FP, three, threeMont)
  const tx = newLimbs()
  fmul(threeMont, xMont, tx)

  fsub(rhs, tx, rhs)
  fadd(rhs, B_MONT, rhs)
  return equals(lhs, rhs)
}

// --- Public API ---

// Uncompressed SEC1: 0x04 || X || Y.
export function encodePublicKey (affine) {
  const out = new Uint8Array(65)
  out[0] = 0x04
  out.set(limbsToBytes(affine.x), 1)
  out.set(limbsToBytes(affine.y), 33)
  return out
}

export function decodePublicKey (bytes) {
  if (bytes.length !== 65 || bytes[0] !== 0x04) return null

  const x = bytesToLimbs(bytes.subarray(1, 33))
  const y = bytesToLimbs(bytes.subarray(33, 65))
  if (geq(x, P) || geq(y, P)) return null

  const point = newPoint()
  toMont(FP, x, point.x)
  toMont(FP, y, point.y)
  copy(point.z, FP.oneMont)

  if (!isOnCurve(point.x, point.y)) return null
  if (isZero(x) && isZero(y)) return null
  return point
}

export function isValidPrivateKey (bytes) {
  if (bytes.length !== 32) return false
  const d = bytesToLimbs(bytes)
  if (isZero(d)) return false
  return !geq(d, N)
}

export function derivePublicKey (privateKeyBytes) {
  const affine = toAffine(scalarMult(privateKeyBytes, G))
  if (!affine) throw new Error('p256: degenerate public key')
  return encodePublicKey(affine)
}

// Rejection sampling over `randomBytes(32)` until the scalar lands in [1, n-1].
export function generatePrivateKey (randomBytes) {
  for (let attempt = 0; attempt < 32; attempt++) {
    const candidate = randomBytes(32)
    if (isValidPrivateKey(candidate)) return candidate
  }
  throw new Error('p256: could not sample a private key')
}

// Raw ECDH: the affine x-coordinate of privateKey * peerPublicKey, 32 bytes.
// Returns null if the peer key is malformed or off-curve.
export function ecdh (privateKeyBytes, peerPublicKeyBytes) {
  const peer = decodePublicKey(peerPublicKeyBytes)
  if (!peer) return null

  const shared = toAffine(scalarMult(privateKeyBytes, peer))
  if (!shared) return null
  return limbsToBytes(shared.x)
}

export const ORDER_BYTES = limbsToBytes(N)
