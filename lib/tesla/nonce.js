// GCM nonce generation.
//
// Reusing a nonce under one AES-GCM key is not a degradation, it is a total
// break: two messages sharing a nonce leak the GHASH subkey, after which an
// attacker can forge any command they like. Drawing nonces from a random source
// makes that outcome depend on the quality of the source -- and on a watch with
// no CSPRNG, whose DRBG is reseeded from the clock at every launch, a reset RTC
// would replay the entire nonce stream.
//
// So uniqueness is made structural instead, using the deterministic
// construction from NIST SP 800-38D: a fixed field that distinguishes this
// device, followed by an invocation counter that only ever increases.
//
//     nonce = prefix[4] || counter[8]   (big-endian)
//
// Counters are handed out in reserved blocks: the next block start is written to
// storage before any of it is used, so losing power mid-session can only skip
// values, never repeat them.

const NONCE_LENGTH = 12
const PREFIX_LENGTH = 4
const DEFAULT_BLOCK = 512

export function createNonceSource (storage, randomBytes, blockSize) {
  const block = blockSize || DEFAULT_BLOCK

  let prefix = storage.getNoncePrefix()
  if (!prefix || prefix.length !== PREFIX_LENGTH) {
    // Only needs to be distinct per device, not secret; a weak source is
    // acceptable here in a way it is not for the counter.
    prefix = randomBytes(PREFIX_LENGTH)
    storage.setNoncePrefix(prefix)
  }

  let next = storage.reserveNonceBlock(block)
  let remaining = block

  return function nextNonce () {
    if (remaining <= 0) {
      next = storage.reserveNonceBlock(block)
      remaining = block
    }

    const counter = next
    next += 1
    remaining -= 1

    const nonce = new Uint8Array(NONCE_LENGTH)
    nonce.set(prefix)

    // 64-bit big-endian. Counters stay well inside the range a double
    // represents exactly, so this cannot silently lose precision.
    let value = counter
    for (let i = NONCE_LENGTH - 1; i >= PREFIX_LENGTH; i--) {
      nonce[i] = value % 256
      value = Math.floor(value / 256)
    }
    return nonce
  }
}
