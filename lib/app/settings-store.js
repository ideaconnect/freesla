// Persisted settings and key material, over an abstract key-value backend.
//
// The platform binding lives in lib/zepp/storage.js; this holds the logic so it
// can be tested off-device. Everything binary is hex-encoded because the
// backend only stores strings.

import { toHex, fromHex } from '../util/hex.js'

const KEY_PRIVATE = 'freesla.privateKey'
const KEY_PUBLIC = 'freesla.publicKey'
const KEY_VIN = 'freesla.vin'
const KEY_ENROLLED = 'freesla.enrolled'
const KEY_AUTO_UNLOCK = 'freesla.autoUnlock'
const KEY_PROVENANCE = 'freesla.keyProvenance'
const KEY_MIN_RSSI = 'freesla.minRssi'
const KEY_SESSION_PREFIX = 'freesla.sk.'
const KEY_NONCE_PREFIX = 'freesla.noncePrefix'
const KEY_NONCE_COUNTER = 'freesla.nonceCounter'

// Roughly "within a few metres" — BLE sits near -60 dBm at 1 m and about
// -80 dBm at 10 m. Erring tight on purpose: failing to auto-unlock costs a
// button press, whereas opening the car while its owner merely walks past
// leaves it standing unlocked.
export const DEFAULT_MIN_RSSI = -70

export function createSettingsStore (backend) {
  function getBytes (key) {
    const value = backend.getItem(key, '')
    return value ? fromHex(value) : null
  }

  function setBytes (key, bytes) {
    backend.setItem(key, toHex(bytes))
  }

  const store = {
    getPrivateKey () { return getBytes(KEY_PRIVATE) },
    getPublicKey () { return getBytes(KEY_PUBLIC) },

    setKeyPair (privateKey, publicKey) {
      setBytes(KEY_PRIVATE, privateKey)
      setBytes(KEY_PUBLIC, publicKey)
    },

    getVin () {
      const vin = backend.getItem(KEY_VIN, '')
      return vin || null
    },

    setVin (vin) {
      // The VIN is bound into every command signature, so changing it
      // invalidates any session derived under the old one.
      if (vin !== store.getVin()) store.clearSessionKeys()
      backend.setItem(KEY_VIN, vin)
    },

    isEnrolled () { return backend.getItem(KEY_ENROLLED, '') === '1' },
    setEnrolled (value) { backend.setItem(KEY_ENROLLED, value ? '1' : '0') },

    // Off by default: opening a car with no button press is a decision the
    // owner should opt into, not inherit.
    autoUnlockEnabled () { return backend.getItem(KEY_AUTO_UNLOCK, '') === '1' },
    setAutoUnlock (value) { backend.setItem(KEY_AUTO_UNLOCK, value ? '1' : '0') },

    // How the stored key was made. Only 'strong' is trusted; anything else,
    // including a key inherited from an older build, means regenerate.
    getKeyProvenance () {
      const value = backend.getItem(KEY_PROVENANCE, '')
      return value || null
    },
    setKeyProvenance (value) { backend.setItem(KEY_PROVENANCE, value) },

    getMinRssi () {
      const raw = backend.getItem(KEY_MIN_RSSI, '')
      const value = raw ? parseInt(raw, 10) : NaN
      return isNaN(value) ? DEFAULT_MIN_RSSI : value
    },
    setMinRssi (value) { backend.setItem(KEY_MIN_RSSI, String(value)) },

    // Caching the ECDH result per vehicle key is what keeps unlocking instant:
    // without it, every session would repeat a scalar multiplication.
    getSessionKey (id) { return getBytes(KEY_SESSION_PREFIX + id.slice(0, 32)) },
    setSessionKey (id, key) { setBytes(KEY_SESSION_PREFIX + id.slice(0, 32), key) },

    clearSessionKeys () {
      backend.removeItem(KEY_ENROLLED)
    },

    reset () {
      backend.clear()
    },

    asSessionKeyCache () {
      return {
        get (id) { return store.getSessionKey(id) },
        set (id, value) { store.setSessionKey(id, value) }
      }
    },

    getNoncePrefix () { return getBytes(KEY_NONCE_PREFIX) },
    setNoncePrefix (bytes) { setBytes(KEY_NONCE_PREFIX, bytes) },

    // Hands out a block of GCM invocation counters, persisting the end of the
    // block BEFORE any of it is used. A crash or flat battery mid-block then
    // skips the unused values rather than reissuing them, which is what keeps
    // nonces unique without trusting the random source.
    reserveNonceBlock (size) {
      const current = parseInt(backend.getItem(KEY_NONCE_COUNTER, '0'), 10) || 0
      backend.setItem(KEY_NONCE_COUNTER, String(current + size))
      return current
    },

    // The randomness probe keeps its own keys and needs the raw backend.
    probeBackend () { return backend }
  }

  return store
}

// An in-memory backend, used by tests and as the reference for what the
// platform binding must provide.
export function createMemoryBackend () {
  const map = {}
  return {
    getItem (key, fallback) {
      return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : (fallback === undefined ? '' : fallback)
    },
    setItem (key, value) { map[key] = String(value) },
    removeItem (key) { delete map[key] },
    clear () { for (const key of Object.keys(map)) delete map[key] }
  }
}
