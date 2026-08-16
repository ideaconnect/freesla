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
  const controller = createController({ storage, createTransport: factory })
  controller.begin()

  return { vehicle, storage, controller, factory, publicKey }
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

test('key creation is refused outright when the phone supplies nothing', () => {
  const { controller } = setup({ provenance: null })

  assert.strictEqual(controller.generateKey(null), null, 'a key was made without the phone')
  assert.strictEqual(controller.generateKey(new Uint8Array(4)), null, 'weak entropy was accepted')
  assert.strictEqual(controller.state, STATE.NEEDS_KEY)
  assert.ok(controller.detail.indexOf('phone') >= 0)
})

test('key creation succeeds with phone randomness and unlocks the car', async () => {
  const { controller, vehicle, storage } = setup({ provenance: null })

  const result = controller.generateKey(new Uint8Array(48).fill(0x7e))
  assert.ok(result, 'generation failed with good entropy')
  assert.strictEqual(storage.getKeyProvenance(), PROVENANCE_STRONG)

  // The new key is not the one the vehicle knows, so enrol it as the owner would.
  vehicle.enrol(storage.getPublicKey())
  storage.setEnrolled(true)

  controller.connect()
  await settle()
  controller.unlock()
  await settle()

  assert.strictEqual(unlocks(vehicle), 1)
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

test('the default proximity floor is sane', () => {
  const storage = createSettingsStore(createMemoryBackend())
  assert.strictEqual(storage.getMinRssi(), DEFAULT_MIN_RSSI)
  assert.ok(DEFAULT_MIN_RSSI < -30 && DEFAULT_MIN_RSSI > -100, 'implausible default')

  storage.setMinRssi(-60)
  assert.strictEqual(storage.getMinRssi(), -60)
})
