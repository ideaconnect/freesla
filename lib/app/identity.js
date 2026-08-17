// The watch's key identity.
//
// The keypair is made on the phone and installed here. Two independent reasons
// point the same way, and either alone would be enough:
//
//   * Zepp OS has no cryptographically secure RNG. Math.random is seeded once
//     per launch from a clock reading, and the public key travels in the clear
//     over BLE, so a watch-chosen key hands an attacker a free offline oracle
//     to test guesses against. A key that weak is worse than none, because the
//     car trusts it exactly like a real one.
//   * Deriving a public key is a P-256 scalar multiplication: ~14ms on a phone,
//     ~87 seconds on this interpreter. There is no native crypto to reach for
//     -- Zepp OS 3.0 exposes twenty-one modules and not one of them does
//     hashing, curves or randomness.
//
// So the watch does no asymmetric maths at all. It holds a key, checks it, and
// spends it on AES-GCM and HMAC, which are cheap. The same rule sends the ECDH
// to the phone as well; see createClient's deriveSharedSecret.

import { isValidPrivateKey, decodePublicKey } from '../crypto/p256.js'

// Marks a key as having been created with phone-supplied randomness.
export const PROVENANCE_STRONG = 'strong'

export function createIdentity (storage) {
  const observations = []

  return {
    // Adds externally-sourced entropy, such as BLE scan results. Nearby device
    // addresses and their RSSI are the least predictable thing the watch can
    // reach without extra permissions.
    //
    // No longer key material -- the key comes from the phone -- but the watch
    // still draws routing addresses and request uuids locally, and those are
    // better for it.
    observe (bytes) {
      if (bytes && observations.length < 64) observations.push(bytes)
    },

    entropySources () { return observations },

    hasKey () {
      const priv = storage.getPrivateKey()
      return !!priv && isValidPrivateKey(priv)
    },

    // A key is only trusted if it is present, valid, AND recorded as having
    // been made with phone-supplied randomness. A key from an older build
    // carries no such record and must be replaced rather than relied on.
    hasTrustedKey () {
      return this.hasKey() && storage.getKeyProvenance() === PROVENANCE_STRONG
    },

    load () {
      const privateKey = storage.getPrivateKey()
      const publicKey = storage.getPublicKey()
      if (!privateKey || !publicKey || !isValidPrivateKey(privateKey)) return null
      return { privateKey, publicKey }
    },

    // Takes a keypair made on the phone. The only way a key gets here.
    //
    // What is given up is that the private key crosses the link once: anyone
    // who captures that single message holds the car key. That is a real cost,
    // accepted because the alternative is not "the watch makes its own" but
    // "the watch makes a guessable one, slowly".
    //
    // Checked before it is kept, because "the phone said so" is not a reason to
    // store something as a car key. The private key must be a valid scalar and
    // the public key a real point on the curve. What is deliberately not
    // checked is that the two correspond: that means deriving the public key,
    // which is the ninety seconds this exists to avoid. A mismatched pair fails
    // at enrolment, visibly, and is not a safety problem -- the car simply
    // never accepts it.
    installKeyPair (privateKey, publicKey) {
      if (!privateKey || !isValidPrivateKey(privateKey)) {
        throw new Error('the phone sent an unusable private key')
      }
      if (!publicKey || !decodePublicKey(publicKey)) {
        throw new Error('the phone sent a public key that is not on the curve')
      }

      storage.setKeyPair(privateKey, publicKey)
      storage.setEnrolled(false)
      storage.setKeyProvenance(PROVENANCE_STRONG)

      return { privateKey, publicKey, observationCount: observations.length }
    }
  }
}

// Tesla VINs are 17 characters and never use I, O or Q, which keeps them
// unambiguous. Catching a typo here saves the user a failed pairing attempt,
// since a wrong VIN produces a car that simply never appears in a scan.
//
// Re-exported rather than defined here: the phone side needs the same rules and
// must not pull the key material in to get them.
export { normaliseVin } from './vin.js'
