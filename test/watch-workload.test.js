// What the watch is allowed to compute.
//
// Every elliptic-curve operation in this app costs about 14ms in a phone's JS
// engine and about 87 seconds on the watch's interpreter -- an interpreter gap,
// not an algorithmic one, and there is nothing native to fall back on: Zepp OS
// 3.0 declares twenty-one modules and not one of them does curves, hashing or
// randomness.
//
// So the rule is that the watch does none of it. The keypair is made on the
// phone at pairing, and the ECDH shared secret is derived on the phone at first
// contact with a car; the watch caches both and spends them on AES-GCM and
// HMAC, which cost microseconds.
//
// This file is the guard on that rule, and it exists because the rule has been
// broken once already in a way nothing else could catch. The session-key
// derivation ran synchronously inside the Bluetooth notification callback that
// delivered the vehicle's handshake reply. Every test passed, because under
// Node that call takes 14ms. On the watch it held a native callback for 87
// seconds and the watchdog reset the device -- reported, accurately, as the
// watch shutting down as soon as it said "Connecting".
//
// Two things are checked, because either alone would have missed it: that the
// expensive calls are not reachable from watch code at all, and that the seam
// they were moved behind really is asynchronous.

import { test } from 'node:test'
import assert from 'node:assert'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'

import { createClient } from '../lib/tesla/client.js'
import { localSharedSecret } from '../lib/tesla/session.js'
import { derivePublicKey, generatePrivateKey } from '../lib/crypto/p256.js'
import { createMockVehicle } from '../tools/mock-vehicle.js'

const VIN = '5YJ30123456789ABC'

function randomBytes (n) {
  return new Uint8Array(crypto.randomBytes(n))
}

function source (path) {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8')
}

// Everything that runs on the watch. Diagnostics is on the list because it is
// where the second instance of this bug lived: it timed a scalar
// multiplication to find out how slow the watch was, which reset the watch.
const WATCH_PATH = [
  'page/index.js',
  'page/controls.js',
  'page/diagnostics.js',
  'lib/app/controller.js',
  'lib/app/device-name.js',
  'lib/app/identity.js',
  'lib/tesla/client.js',
  'lib/zepp/ble-session.js'
]

// Each of these is a P-256 scalar multiplication, or a wrapper around one.
const FORBIDDEN = [
  'ecdh',
  'scalarMult',
  'derivePublicKey',
  'generatePrivateKey',
  'deriveSessionKey',
  'localSharedSecret'
]

test('no watch-side module calls into the curve arithmetic', () => {
  for (const path of WATCH_PATH) {
    const text = source(path)
    for (const name of FORBIDDEN) {
      assert.ok(!new RegExp('\\b' + name + '\\s*\\(').test(text),
        path + ' calls ' + name + '(), which is ~87 seconds on the watch')
    }
  }
})

test('no watch-side module imports the curve arithmetic either', () => {
  // Calls are the thing that hurts, but an import is how one gets written. The
  // two cheap checks are allowed through: they are field comparisons and a
  // single curve-equation evaluation, not a scalar multiplication.
  const ALLOWED = ['isValidPrivateKey', 'decodePublicKey']

  for (const path of WATCH_PATH) {
    const text = source(path)
    const imports = text.match(/import\s*\{([^}]*)\}\s*from\s*'[^']*p256\.js'/)
    if (!imports) continue

    for (const name of imports[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      assert.ok(ALLOWED.indexOf(name) >= 0,
        path + ' imports ' + name + ' from p256; only ' + ALLOWED.join(' and ') + ' are cheap')
    }
  }
})

test('every page that builds a controller gives it somewhere to send the maths', () => {
  // createClient throws without a delegate, but the controller wraps it, so a
  // page that forgets one fails only at the handshake -- and only against a car
  // this watch has never met, which is the one case a person testing at their
  // own car will not hit. page/controls.js shipped exactly that way: every
  // closure it offers would have failed on first contact with a new car while
  // the main screen worked.
  for (const path of WATCH_PATH) {
    const text = source(path)
    if (!/createController\s*\(/.test(text)) continue
    assert.ok(/deriveSharedSecret/.test(text),
      path + ' builds a controller with no deriveSharedSecret, so any command ' +
      'to a car it has not met before cannot complete')
  }
})

test('a client cannot be built without somewhere to send the curve maths', () => {
  // Not defaulted to the local implementation on purpose. A default would be
  // the 87-second one, and it would be picked up silently by exactly the code
  // that must never use it.
  assert.throws(() => createClient({
    vin: VIN,
    privateKey: generatePrivateKey(randomBytes),
    publicKey: new Uint8Array(65),
    link: { onMessage () {}, send () {} },
    randomBytes
  }), /deriveSharedSecret is required/)
})

test('the reply that needs a secret does not block the callback it arrives on', () => {
  // The heart of it. On the watch, the frame carrying the vehicle's public key
  // is delivered by the Bluetooth stack on its own callback, and that callback
  // has to be given back promptly. Here the derivation is held open, and the
  // assertion is simply that control came back anyway.
  const vehicle = createMockVehicle({ vin: VIN })
  const privateKey = generatePrivateKey(randomBytes)
  const publicKey = derivePublicKey(privateKey)
  vehicle.enrol(publicKey)

  let release = null
  const client = createClient({
    vin: VIN,
    privateKey,
    publicKey,
    link: vehicle.link,
    randomBytes,
    deriveSharedSecret: (priv, peer, cb) => {
      release = () => localSharedSecret(priv, peer, cb)
    }
  })

  let settled = null
  client.unlock((err) => { settled = err || 'ok' })

  return new Promise((resolve) => setTimeout(resolve, 60)).then(() => {
    assert.ok(release, 'the handshake reply never asked for a secret')
    assert.strictEqual(settled, null, 'the command settled before it had a session key')

    release()
    return new Promise((resolve) => setTimeout(resolve, 60))
  }).then(() => {
    assert.strictEqual(settled, 'ok', 'the command never completed once the phone answered: ' + settled)
    assert.strictEqual(vehicle.events.filter((e) => e.type === 'rke').length, 1)
  })
})

test('a phone that never answers leaves the command failed, not hanging', () => {
  const vehicle = createMockVehicle({ vin: VIN })
  const privateKey = generatePrivateKey(randomBytes)
  const publicKey = derivePublicKey(privateKey)
  vehicle.enrol(publicKey)

  const client = createClient({
    vin: VIN,
    privateKey,
    publicKey,
    link: vehicle.link,
    randomBytes,
    deriveSharedSecret: (priv, peer, cb) => setTimeout(() => cb(new Error('no phone in range')), 5)
  })

  return new Promise((resolve, reject) => {
    client.unlock((err) => {
      try {
        assert.ok(err, 'the command reported success with no session key')
        assert.match(err.message, /no phone in range/)
        assert.strictEqual(vehicle.events.filter((e) => e.type === 'rke').length, 0)
        resolve()
      } catch (e) {
        reject(e)
      }
    })
  })
})
