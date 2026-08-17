// Auto-unlock behaviour.
//
// This is the one feature that acts on the car without anyone touching the
// watch, so its guard conditions are worth testing directly: it must never fire
// when disabled, when the key is not enrolled, when the car is too far away, or
// twice for a single approach.

import { test } from 'node:test'
import assert from 'node:assert'
import crypto from 'node:crypto'

import { createController, STATE } from '../lib/app/controller.js'
import { createSettingsStore, createMemoryBackend, DEFAULT_MIN_RSSI } from '../lib/app/settings-store.js'
import { PROVENANCE_STRONG } from '../lib/app/identity.js'
import {
  CLOSURE_FIELD, CLOSURE_STATE, VEHICLE_LOCK_STATE, TRUST
} from '../lib/tesla/constants.js'
import { createMockVehicle } from '../tools/mock-vehicle.js'
import { createFakeTransportFactory } from '../tools/fake-transport.js'
import { derivePublicKey, generatePrivateKey } from '../lib/crypto/p256.js'
import { localSharedSecret } from '../lib/tesla/session.js'

const VIN = '5YJ30123456789ABC'

function randomBytes (n) {
  return new Uint8Array(crypto.randomBytes(n))
}

function setup (options) {
  const settings = options || {}
  const vehicle = createMockVehicle({ vin: VIN })
  const storage = createSettingsStore(createMemoryBackend())

  const privateKey = generatePrivateKey(randomBytes)
  const publicKey = derivePublicKey(privateKey)

  storage.setVin(VIN)
  storage.setKeyPair(privateKey, publicKey)
  // Stands for a key properly created with the phone's randomness; without
  // this the controller correctly refuses to use it.
  if (settings.provenance !== null) storage.setKeyProvenance(PROVENANCE_STRONG)
  storage.setEnrolled(settings.enrolled !== false)
  if (settings.autoUnlock) storage.setAutoUnlock(true)
  if (settings.minRssi !== undefined) storage.setMinRssi(settings.minRssi)
  if (settings.enrolled !== false) vehicle.enrol(publicKey)

  const factory = createFakeTransportFactory(vehicle, { rssi: settings.rssi })
  // On the watch this is a round trip to the phone, because the curve maths
  // behind it takes about 87 seconds there. Counted so tests can assert on how
  // often it actually happens, which is meant to be once per car, ever.
  const derivations = []
  const controller = createController({
    storage,
    createTransport: factory,
    deriveSharedSecret: settings.deriveSharedSecret ||
      ((priv, pub, cb) => {
        derivations.push(pub)
        localSharedSecret(priv, pub, cb)
      })
  })
  controller.begin()

  return { vehicle, storage, controller, factory, publicKey, derivations }
}

function settle (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms === undefined ? 80 : ms))
}

function unlocks (vehicle) {
  return vehicle.events.filter((e) => e.type === 'rke' && e.action === 0).length
}

test('auto-unlock stays off unless it is turned on', async () => {
  const { controller, vehicle } = setup({ autoUnlock: false })

  controller.connect()
  await settle()

  assert.strictEqual(unlocks(vehicle), 0, 'car unlocked without the setting enabled')
  assert.strictEqual(controller.state, STATE.READY)
})

test('auto-unlock opens the car on approach when enabled', async () => {
  const { controller, vehicle } = setup({ autoUnlock: true })

  controller.connect()
  await settle()

  assert.strictEqual(unlocks(vehicle), 1, 'expected exactly one unlock')
})

test('auto-unlock fires once per approach, not repeatedly', async () => {
  const { controller, vehicle, factory } = setup({ autoUnlock: true })

  controller.connect()
  await settle()
  assert.strictEqual(unlocks(vehicle), 1)

  // Still parked beside the car; nothing should reopen it.
  factory.current().connect()
  await settle()
  assert.strictEqual(unlocks(vehicle), 1, 'car reopened without going out of range')
})

test('auto-unlock re-arms after the car goes out of range', async () => {
  const { controller, vehicle, factory } = setup({ autoUnlock: true })

  controller.connect()
  await settle()
  assert.strictEqual(unlocks(vehicle), 1)

  factory.current().simulateDisconnect()
  await settle(10)
  controller.connect()
  await settle()

  assert.strictEqual(unlocks(vehicle), 2, 'did not re-arm after a disconnect')
})

test('auto-unlock refuses a car that is only weakly in range', async () => {
  const { controller, vehicle } = setup({ autoUnlock: true, rssi: -95 })

  controller.connect()
  await settle()

  assert.strictEqual(unlocks(vehicle), 0, 'unlocked a distant car')
  assert.ok(controller.detail.indexOf('closer') >= 0, 'no explanation shown: ' + controller.detail)
})

test('a strong signal passes the proximity check', async () => {
  const { controller, vehicle } = setup({ autoUnlock: true, rssi: -45 })

  controller.connect()
  await settle()
  assert.strictEqual(unlocks(vehicle), 1)
})

test('auto-unlock never fires for a key the car has not enrolled', async () => {
  const { controller, vehicle } = setup({ autoUnlock: true, enrolled: false })

  controller.connect()
  await settle()

  assert.strictEqual(unlocks(vehicle), 0)
  assert.strictEqual(controller.state, STATE.NEEDS_ENROLMENT)
})

test('enabling auto-unlock beside a connected car takes effect immediately', async () => {
  const { controller, vehicle } = setup({ autoUnlock: false })

  controller.connect()
  await settle()
  assert.strictEqual(unlocks(vehicle), 0)

  controller.setAutoUnlock(true)
  await settle()
  assert.strictEqual(unlocks(vehicle), 1)
})

test('manual commands still work with auto-unlock off', async () => {
  const { controller, vehicle } = setup({ autoUnlock: false })

  controller.connect()
  await settle()
  controller.lock()
  await settle()

  assert.strictEqual(vehicle.events.filter((e) => e.type === 'rke' && e.action === 1).length, 1)
})

test('scanning feeds observations into the entropy pool', async () => {
  const vehicle = createMockVehicle({ vin: VIN })
  const storage = createSettingsStore(createMemoryBackend())
  storage.setVin(VIN)

  const observed = []
  const factory = createFakeTransportFactory(vehicle, {})
  const controller = createController({
    storage,
    createTransport: (options) => {
      const inner = factory({
        ...options,
        onObservation (bytes) {
          observed.push(bytes)
          options.onObservation(bytes)
        }
      })
      return inner
    }
  })

  controller.begin()
  controller.connect()
  await settle(20)

  // The observation path must actually be wired: this was silently dead once.
  assert.ok(observed.length > 0, 'no scan observations reached the controller')
})

test('a key with no recorded provenance is not used at all', async () => {
  // A key left by an older build, before the phone was required. It must be
  // replaced rather than trusted, even though it is cryptographically valid.
  const { controller, vehicle } = setup({ autoUnlock: true, provenance: null })

  assert.strictEqual(controller.state, STATE.NEEDS_KEY)
  assert.ok(controller.detail.indexOf('phone') >= 0,
    'no explanation of why the key was rejected: ' + controller.detail)

  controller.connect()
  await settle()
  assert.strictEqual(unlocks(vehicle), 0, 'an untrusted key was used to unlock')
})

test('the session secret is derived once per car and then never again', async () => {
  // The crash this guards against: the ECDH behind this is a P-256 scalar
  // multiplication, ~14ms here and ~87 seconds on the watch's interpreter, and
  // the frame that triggers it arrives on a native Bluetooth callback. Blocking
  // one of those for 87 seconds does not freeze the screen, it resets the
  // watch. So it happens on the phone -- and only for a car never met before.
  const { controller, vehicle, derivations } = setup()

  controller.connect()
  await settle()
  controller.unlock()
  await settle()

  assert.strictEqual(unlocks(vehicle), 1)
  assert.strictEqual(derivations.length, 1, 'the phone was asked more than once')

  controller.lock()
  await settle()
  controller.unlock()
  await settle()

  assert.strictEqual(derivations.length, 1,
    'the cached secret was ignored and the phone asked again')
})

test('a car met before needs no phone at all', async () => {
  // The whole point of caching it: after the first meeting the watch opens the
  // car alone, which is what the app is for.
  const { controller, storage, vehicle, publicKey } = setup()

  controller.connect()
  await settle()
  controller.unlock()
  await settle()
  assert.strictEqual(unlocks(vehicle), 1)

  // A fresh controller over the same storage, with a phone that would throw if
  // it were consulted.
  const second = createController({
    storage,
    createTransport: createFakeTransportFactory(vehicle, {}),
    deriveSharedSecret: () => assert.fail('the phone was asked for a known car')
  })
  second.begin()
  second.connect()
  await settle()
  second.unlock()
  await settle()

  assert.strictEqual(unlocks(vehicle), 2, 'the second unlock never landed')
  assert.ok(publicKey.length === 65)
})

test('an unreachable phone fails the command rather than hanging', async () => {
  // No phone in range on first contact with a car. The command has to come back
  // with something the wearer can act on; the old behaviour was to sit on the
  // last painted frame until the watchdog fired.
  const { controller, vehicle } = setup({
    deriveSharedSecret: (priv, pub, cb) => setTimeout(() => cb(new Error('no phone')), 1)
  })

  controller.connect()
  await settle()
  controller.unlock()
  await settle()

  assert.strictEqual(unlocks(vehicle), 0, 'the car was opened without a session')
  assert.strictEqual(controller.state, STATE.ERROR)
  assert.ok(/phone/i.test(controller.detail),
    'the failure does not mention the phone: ' + controller.detail)
})

test('a slow phone does not time the handshake out from under itself', async () => {
  // Eight seconds is a fair wait for a car answering over BLE. It is not a fair
  // wait for a phone that has to be woken from the background first, and
  // expiring the request underneath a derivation that is about to succeed would
  // throw away the one expensive result in the protocol.
  let asked = 0
  const { controller, vehicle } = setup({
    deriveSharedSecret: (priv, pub, cb) => setTimeout(() => {
      asked++
      localSharedSecret(priv, pub, cb)
    }, 60)
  })

  controller.connect()
  await settle()
  controller.unlock()
  await settle(400)

  assert.strictEqual(asked, 1, 'the phone was not asked exactly once')
  assert.strictEqual(unlocks(vehicle), 1, 'a slow but successful phone lost the command')
})

test('a keypair made on the phone is installed at once', async () => {
  const { controller, vehicle, storage } = setup({ provenance: null })
  assert.strictEqual(controller.state, STATE.NEEDS_KEY)

  const privateKey = generatePrivateKey(randomBytes)
  const publicKey = derivePublicKey(privateKey)

  const result = controller.installKeyPair(privateKey, publicKey)
  assert.ok(result, 'the keypair was rejected')
  assert.strictEqual(storage.getKeyProvenance(), PROVENANCE_STRONG)
  assert.deepStrictEqual(storage.getPrivateKey(), privateKey)

  // And it is a working key, not merely a stored one.
  vehicle.enrol(publicKey)
  storage.setEnrolled(true)
  controller.connect()
  await settle()
  controller.unlock()
  await settle()
  assert.strictEqual(unlocks(vehicle), 1)
})

test('a keypair the phone got wrong is refused, not stored', async () => {
  // "The phone said so" is not a reason to keep something as a car key. The
  // one check deliberately skipped is that the two halves correspond, since
  // that means deriving -- the ninety seconds this whole path avoids.
  //
  // Started from a watch with no key at all, so anything found in storage
  // afterwards can only have come from this call.
  const vehicle = createMockVehicle({ vin: VIN })
  const storage = createSettingsStore(createMemoryBackend())
  storage.setVin(VIN)
  const controller = createController({
    storage,
    createTransport: createFakeTransportFactory(vehicle, {}),
    deriveSharedSecret: localSharedSecret
  })
  controller.begin()

  const good = generatePrivateKey(randomBytes)
  const goodPublic = derivePublicKey(good)

  const cases = [
    ['a private key of the wrong length', new Uint8Array(16), goodPublic],
    ['a zero private key', new Uint8Array(32), goodPublic],
    ['a public key that is not on the curve', good, (() => {
      const bent = new Uint8Array(goodPublic)
      bent[40] ^= 0xff
      return bent
    })()],
    ['a truncated public key', good, goodPublic.subarray(0, 40)]
  ]

  for (const [what, priv, pub] of cases) {
    assert.strictEqual(controller.installKeyPair(priv, pub), null, what + ' was accepted')
    assert.strictEqual(storage.getPrivateKey(), null, what + ' reached storage')
    assert.strictEqual(controller.state, STATE.NEEDS_KEY)
  }
})

test('a new key does not inherit the old key’s cached session secret', async () => {
  // The secret is a function of both key pairs, so a cache keyed on the vehicle
  // alone would hand a freshly made key the previous key's secret. Nothing
  // would notice until the handshake, which would then fail authentication
  // against a car that had done nothing wrong -- for good, with nothing to
  // clear and no way out but reinstalling.
  const vehicle = createMockVehicle({ vin: VIN })
  const storage = createSettingsStore(createMemoryBackend())
  storage.setVin(VIN)

  const oldPrivate = generatePrivateKey(randomBytes)
  const oldPublic = derivePublicKey(oldPrivate)
  storage.setKeyPair(oldPrivate, oldPublic)
  storage.setKeyProvenance(PROVENANCE_STRONG)
  storage.setEnrolled(true)
  vehicle.enrol(oldPublic)

  const secrets = []
  const build = () => {
    const controller = createController({
      storage,
      createTransport: createFakeTransportFactory(vehicle, {}),
      deriveSharedSecret: (priv, pub, cb) => localSharedSecret(priv, pub, (err, shared) => {
        secrets.push(shared)
        cb(err, shared)
      })
    })
    controller.begin()
    return controller
  }

  const before = build()
  before.connect()
  await settle()
  before.unlock()
  await settle()
  assert.strictEqual(unlocks(vehicle), 1)
  assert.strictEqual(secrets.length, 1)

  // The owner makes a new key, as they would after a reinstall on the phone.
  // Deliberately without disconnecting first: the controller has a live client
  // holding the old key, and it is that client which must not be reused.
  const newPrivate = generatePrivateKey(randomBytes)
  const newPublic = derivePublicKey(newPrivate)
  before.installKeyPair(newPrivate, newPublic)
  storage.setEnrolled(true)
  vehicle.enrol(newPublic)

  const after = build()
  after.connect()
  await settle()
  after.unlock()
  await settle()

  assert.strictEqual(secrets.length, 2, 'the new key reused the old key’s cached secret')
  assert.notDeepStrictEqual(secrets[0], secrets[1], 'both keys produced the same secret')
  assert.strictEqual(unlocks(vehicle), 2, 'the new key could not open the car')
})

test('vehicle status reaches the controller and is trusted when authenticated', async () => {
  const { controller, vehicle } = setup()

  vehicle.setClosureState(CLOSURE_FIELD.FRONT_DRIVER_DOOR, CLOSURE_STATE.AJAR)
  vehicle.setClosureState(CLOSURE_FIELD.REAR_TRUNK, CLOSURE_STATE.OPEN)
  vehicle.setLockState(VEHICLE_LOCK_STATE.UNLOCKED)

  controller.connect()
  await settle()
  controller.refreshStatus()
  await settle()

  assert.ok(controller.vehicleStatus, 'no status arrived')
  assert.strictEqual(controller.closureState(CLOSURE_FIELD.FRONT_DRIVER_DOOR), CLOSURE_STATE.AJAR)
  assert.strictEqual(controller.closureState(CLOSURE_FIELD.REAR_TRUNK), CLOSURE_STATE.OPEN)
  assert.strictEqual(controller.closureState(CLOSURE_FIELD.FRONT_PASSENGER_DOOR), CLOSURE_STATE.CLOSED)
  assert.strictEqual(controller.vehicleStatus.lockState, VEHICLE_LOCK_STATE.UNLOCKED)

  // The mock encrypts its replies, so this arrived as a verified answer to our
  // own signed request rather than an unauthenticated broadcast.
  assert.strictEqual(controller.statusTrust, TRUST.VERIFIED)
})

test('a command refresh keeps the indicator current', async () => {
  const { controller, vehicle } = setup()
  controller.connect()
  await settle()

  vehicle.setClosureState(CLOSURE_FIELD.FRONT_TRUNK, CLOSURE_STATE.OPEN)
  controller.openFrunk()
  await settle()

  // Every command refreshes status afterwards, so the frunk should now read open
  // without the screen having to ask separately.
  assert.strictEqual(controller.closureState(CLOSURE_FIELD.FRONT_TRUNK), CLOSURE_STATE.OPEN)
})

// Pairing: the one sequence a new owner has to get through, and the only one
// where the watch talks to a car that does not know it yet. It used to require
// a connection nothing on that screen could open, so these cover the way in as
// much as the enrolment itself.

function enrolmentRequests (vehicle) {
  return vehicle.events.filter((e) => e.type === 'enrolment-requested').length
}

test('pairing can be started with no connection already open', async () => {
  const { controller, vehicle } = setup({ enrolled: false })

  // Exactly the state a watch is in after Create key: a trusted key, a car it
  // has never spoken to, and the owner standing next to it.
  assert.strictEqual(controller.state, STATE.NEEDS_ENROLMENT)

  controller.requestEnrolment()
  await settle()

  assert.strictEqual(enrolmentRequests(vehicle), 1, 'the car was never asked')
  assert.strictEqual(controller.state, STATE.ENROLLING)
  assert.ok(controller.detail.indexOf('keycard') >= 0,
    'no keycard instruction shown: ' + controller.detail)
})

test('pairing works end to end from a cold start', async () => {
  const { controller, vehicle, storage, publicKey } = setup({ enrolled: false })

  controller.requestEnrolment()
  await settle()

  // The owner taps their existing keycard on the console.
  assert.ok(vehicle.tapKeycard(), 'no enrolment was pending on the car')
  assert.ok(vehicle.isEnrolled(publicKey), 'the car did not take the key')

  controller.checkEnrolment()
  await settle()

  assert.strictEqual(controller.state, STATE.READY)
  assert.ok(storage.isEnrolled(), 'enrolment was not remembered')
  // The check is a real unlock: the only way to learn whether the car accepts
  // this key is to send it something and see. Confirming pairing opens the car.
  assert.strictEqual(unlocks(vehicle), 1)

  controller.unlock()
  await settle()
  assert.strictEqual(unlocks(vehicle), 2, 'the paired key cannot open the car')
})

test('checking enrolment reconnects rather than doing nothing', async () => {
  const { controller, vehicle, factory, publicKey, storage } = setup({ enrolled: false })

  controller.requestEnrolment()
  await settle()
  vehicle.tapKeycard()

  // The car goes out of range between the keycard tap and the confirmation --
  // easily done, since the tap happens at the console and not at the wrist.
  factory.current().simulateDisconnect()
  await settle(10)
  assert.strictEqual(controller.state, STATE.DISCONNECTED)

  controller.checkEnrolment()
  await settle()

  assert.ok(vehicle.isEnrolled(publicKey))
  assert.strictEqual(controller.state, STATE.READY, 'the check gave up: ' + controller.detail)
  assert.ok(storage.isEnrolled())
})

test('a pairing request is never replayed on a later reconnect', async () => {
  const { controller, vehicle, factory } = setup({ enrolled: false })

  controller.requestEnrolment()
  await settle()
  assert.strictEqual(enrolmentRequests(vehicle), 1)

  // Walking away and back must not ask the car to enrol a second time: the
  // request is the owner's decision, not something a reconnect re-makes.
  factory.current().simulateDisconnect()
  await settle(10)
  controller.connect()
  await settle()

  assert.strictEqual(enrolmentRequests(vehicle), 1, 'enrolment was asked for again')
  assert.strictEqual(controller.state, STATE.NEEDS_ENROLMENT)
})

test('pairing is refused outright when there is no usable key', async () => {
  const { controller, vehicle } = setup({ enrolled: false, provenance: null })

  controller.requestEnrolment()
  await settle()

  assert.strictEqual(enrolmentRequests(vehicle), 0, 'an untrusted key was offered to the car')
  assert.strictEqual(controller.state, STATE.NEEDS_KEY)
})

test('the default proximity floor is sane', () => {
  const storage = createSettingsStore(createMemoryBackend())
  assert.strictEqual(storage.getMinRssi(), DEFAULT_MIN_RSSI)
  assert.ok(DEFAULT_MIN_RSSI < -30 && DEFAULT_MIN_RSSI > -100, 'implausible default')

  storage.setMinRssi(-60)
  assert.strictEqual(storage.getMinRssi(), -60)
})

test('leaving the screen mid-derivation does not report back later', async () => {
  // The wearer walks away while the phone is still answering. onDestroy calls
  // disconnect(), and until the client was told to let go, three things
  // outlived it: the request's own timeout, the derivation's continuation, and
  // the command callback behind both. The timeout fired seconds later and put
  // "command timed out" over whatever screen had replaced this one.
  let answer = null
  const { controller, vehicle } = setup({
    deriveSharedSecret: (priv, pub, cb) => { answer = () => localSharedSecret(priv, pub, cb) }
  })

  controller.connect()
  await settle()
  controller.unlock()
  await settle()

  assert.ok(answer, 'the phone was never asked')

  controller.disconnect()
  const after = { state: controller.state, detail: controller.detail }

  // The phone finally answers, long after nobody is listening. Waited out well
  // past the request's own 8s timeout is not practical here, so the check is
  // that nothing moves at all -- the timer was unscheduled with the client.
  answer()
  await settle(200)

  assert.strictEqual(controller.state, after.state,
    'an abandoned derivation moved the controller to ' + controller.state)
  assert.strictEqual(controller.detail, after.detail,
    'an abandoned derivation repainted the screen: ' + controller.detail)
  assert.strictEqual(unlocks(vehicle), 0, 'a command completed after disconnect')
})

test('a phone that refuses says why, rather than being told to come closer', async () => {
  // "Bring your phone closer" is the right advice for an absent phone and
  // useless for a present one that declined -- an off-curve vehicle key is a
  // security signal, not a range problem.
  const refusal = new Error('the vehicle public key is not a valid curve point')
  refusal.reason = 'refused'

  const { controller } = setup({
    deriveSharedSecret: (priv, pub, cb) => setTimeout(() => cb(refusal), 1)
  })

  controller.connect()
  await settle()
  controller.unlock()
  await settle()

  assert.strictEqual(controller.state, STATE.ERROR)
  assert.match(controller.detail, /curve point/,
    'the phone’s reason was replaced with generic advice: ' + controller.detail)
})
