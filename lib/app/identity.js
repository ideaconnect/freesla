// The watch's key identity.
//
// The private key is generated on the watch and never leaves it. That is a
// deliberate trade against the platform's weakest point: Zepp OS has no
// cryptographically secure RNG, so the seed is assembled from whatever
// independent entropy the device can offer and whitened through SHA-256.
//
// The strongest source available without extra permissions is the BLE scan the
// app already performs -- nearby device addresses and their RSSI are outside
// our control and vary with the physical environment. Callers should feed
// observations in before generating a key.

import { generatePrivateKey, derivePublicKey, isValidPrivateKey } from '../crypto/p256.js'
import { collectWatchEntropy, createDrbg } from '../crypto/random.js'

// Below this, supplied entropy is not treated as a real source.
const MIN_STRONG_ENTROPY_BYTES = 16

// Marks a key as having been created with phone-supplied randomness.
export const PROVENANCE_STRONG = 'strong'

export function createIdentity (storage) {
  const observations = []

  return {
    // Adds externally-sourced entropy, such as BLE scan results.
    observe (bytes) {
      if (bytes && observations.length < 64) observations.push(bytes)
    },

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

    // Generates and persists a keypair. Blocking and slow -- one elliptic-curve
    // scalar multiplication in an interpreter -- so the caller should paint a
    // progress message and yield before invoking it.
    //
    // `externalEntropy` is bytes from a stronger source than the watch has,
    // normally the phone's CSPRNG. It is prepended rather than substituted, so
    // the seed is SHA-256(external || watch): an attacker has to defeat both
    // sources, and neither one being weak is sufficient on its own.
    // Requires real randomness. There is no override and no degraded mode.
    //
    // On this runtime Math.random() is seeded once per launch from a clock
    // reading, so a watch-only seed collapses to little more than "when was the
    // key made" -- and the public key travels in the clear over BLE, giving an
    // attacker a free offline oracle to test guesses against. A key that weak
    // is worse than no key, because the car trusts it exactly like a real one.
    //
    // This is the only moment the phone is needed. Once the key exists the
    // watch operates alone.
    generate (externalEntropy) {
      if (!externalEntropy || externalEntropy.length < MIN_STRONG_ENTROPY_BYTES) {
        throw new Error('no strong randomness available')
      }

      const local = collectWatchEntropy(observations)

      // seed = SHA-256(phone entropy || watch entropy), so an attacker must
      // defeat both sources rather than either one.
      const seed = new Uint8Array(externalEntropy.length + local.length)
      seed.set(externalEntropy)
      seed.set(local, externalEntropy.length)

      const randomBytes = createDrbg(seed)
      const privateKey = generatePrivateKey(randomBytes)
      const publicKey = derivePublicKey(privateKey)

      storage.setKeyPair(privateKey, publicKey)
      storage.setEnrolled(false)
      // Recorded so a key left behind by an older build, which had no such
      // guarantee, is not mistaken for one made this way.
      storage.setKeyProvenance(PROVENANCE_STRONG)

      return {
        privateKey,
        publicKey,
        observationCount: observations.length
      }
    }
  }
}

// Tesla VINs are 17 characters and never use I, O or Q, which keeps them
// unambiguous. Catching a typo here saves the user a failed pairing attempt,
// since a wrong VIN produces a car that simply never appears in a scan.
export function normaliseVin (input) {
  if (!input) return null
  const vin = String(input).toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (vin.length !== 17) return null
  if (/[IOQ]/.test(vin)) return null
  return vin
}
