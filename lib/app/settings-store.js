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
const KEY_BREADCRUMB = 'freesla.lastStep'

// Roughly "within a few metres": BLE sits near -60 dBm at 1 m and about
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
      // A different VIN is a different car, and this key is not enrolled in it
      // until its owner says so at the console.
      //
      // Cached session secrets are deliberately left alone. They depend on the
      // two key pairs and not at all on the VIN -- which is why they are keyed
      // by the vehicle's public key -- so a new car simply misses the cache
      // rather than reading something that belongs to the old one.
      if (vin !== store.getVin()) store.clearEnrolment()
      backend.setItem(KEY_VIN, vin)
    },

    // The step a connection attempt reached, for reading back after the watch
    // has restarted mid-attempt. See lib/app/breadcrumb.js -- written only by
    // builds that ask for it, because each call is a flash write.
    getBreadcrumb () {
      const value = backend.getItem(KEY_BREADCRUMB, '')
      return value || null
    },
    setBreadcrumb (step) { backend.setItem(KEY_BREADCRUMB, String(step)) },
    clearBreadcrumb () { backend.setItem(KEY_BREADCRUMB, '') },

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

    // Caching the ECDH result per vehicle key is what keeps unlocking instant.
    // Without it every connection would need the curve maths again -- which
    // this watch cannot do at all, so the cache is not an optimisation here so
    // much as the reason the phone is only needed once per car.
    //
    // Namespaced by the watch's own public key, because the secret is a
    // function of both halves. Keyed on the vehicle alone, creating a new key
    // would leave the old key's secret sitting under the same id: the next
    // handshake would read a secret the car no longer shares, fail
    // authentication, and go on failing with nothing to clear and no way out
    // but reinstalling.
    // Eight bytes of the key's own X coordinate, which is plenty to separate
    // one of this watch's keys from another. Skips the leading 0x04 that marks
    // an uncompressed point, since it is the same on every key.
    keyNamespace (ownPublicKey) {
      return toHex(ownPublicKey.subarray(1, 9))
    },

    sessionKeyId (namespace, vehicleId) {
      return KEY_SESSION_PREFIX + namespace + '.' + vehicleId.slice(0, 32)
    },

    getSessionKey (namespace, vehicleId) {
      return getBytes(store.sessionKeyId(namespace, vehicleId))
    },

    setSessionKey (namespace, vehicleId, key) {
      setBytes(store.sessionKeyId(namespace, vehicleId), key)
    },

    clearEnrolment () {
      backend.removeItem(KEY_ENROLLED)
    },

    reset () {
      backend.clear()
    },

    // The namespace is computed once here rather than per lookup: the cache is
    // read on every frame that carries session info, and the key it is derived
    // from cannot change for the life of the handle.
    asSessionKeyCache (ownPublicKey) {
      const namespace = store.keyNamespace(ownPublicKey)
      return {
        get (id) {
          const found = store.getSessionKey(namespace, id)
          if (found) return found

          // Builds before the namespace existed stored this under the vehicle
          // id alone. Such an entry cannot be adopted -- nothing records which
          // of this watch's keys produced it, and using one from a superseded
          // key would fail authentication against a car that had done nothing
          // wrong -- so it is removed rather than read. The cost is deriving
          // once more per car; the alternative is a secret that never expires
          // and can never be verified.
          const legacy = KEY_SESSION_PREFIX + id.slice(0, 32)
          if (backend.getItem(legacy, '')) backend.removeItem(legacy)
          return null
        },
        set (id, value) { store.setSessionKey(namespace, id, value) }
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
