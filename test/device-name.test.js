// Which name the watch scans for.
//
// The scan matches the advertised name exactly and ignores everything else, so
// this one string decides whether a car is reachable at all. The override
// exists because Windows will not let mock-car advertise the name a VIN
// derives; getting it wrong in either direction is silent, and looks from the
// watch exactly like a car that is not there.

import { test } from 'node:test'
import assert from 'node:assert'
import crypto from 'node:crypto'

import { expectedLocalName, localNameOverride } from '../lib/app/device-name.js'
import { BLE_NAME_OVERRIDE } from '../freesla.config.js'
import { vehicleLocalName } from '../lib/tesla/messages.js'
import { createController } from '../lib/app/controller.js'
import { createSettingsStore, createMemoryBackend } from '../lib/app/settings-store.js'
import { PROVENANCE_STRONG } from '../lib/app/identity.js'
import { createMockVehicle } from '../tools/mock-vehicle.js'
import { createFakeTransportFactory } from '../tools/fake-transport.js'
import { derivePublicKey, generatePrivateKey } from '../lib/crypto/p256.js'
import { localSharedSecret } from '../lib/tesla/session.js'

const VIN = '5YJ30123456789ABC'
const DERIVED = vehicleLocalName(VIN)

test('with no override the name comes from the VIN', () => {
  assert.strictEqual(expectedLocalName(VIN, ''), DERIVED)
  assert.strictEqual(localNameOverride(''), null)
})

test('an override replaces the derived name outright', () => {
  assert.strictEqual(expectedLocalName(VIN, 'DESKTOP-4F2A'), 'DESKTOP-4F2A')
  assert.strictEqual(localNameOverride('DESKTOP-4F2A'), 'DESKTOP-4F2A')
})

test('a pasted override is trimmed', () => {
  // Copied out of a terminal, so a trailing newline or space is likely. Left
  // in, it produces a name that matches no advertisement at all.
  assert.strictEqual(expectedLocalName(VIN, '  DESKTOP-4F2A\n'), 'DESKTOP-4F2A')
  assert.strictEqual(localNameOverride('   '), null)
})

test('anything that is not a usable string falls back to the VIN', () => {
  for (const value of [null, 0, false, [], {}]) {
    assert.strictEqual(expectedLocalName(VIN, value), DERIVED)
    assert.strictEqual(localNameOverride(value), null)
  }
})

test('the case of an override is preserved', () => {
  // The scan compares exactly, so folding the case here would produce a name
  // that never matches while looking right in the log.
  assert.strictEqual(expectedLocalName(VIN, 'Desktop-4f2A'), 'Desktop-4f2A')
})

test('whatever the config carries is something the resolver understands', () => {
  // The one thing worth asserting about the configured value itself. Anything
  // that is not a string is treated as no override at all, so a number, or an
  // export renamed by an over-helpful editor, would leave a build quietly
  // scanning for the VIN's name while its author believed otherwise.
  assert.strictEqual(typeof BLE_NAME_OVERRIDE, 'string')

  // Deliberately not asserted empty. A developer testing against mock-car is
  // meant to be in exactly this state, and a suite that goes red for the
  // duration teaches them to ignore it. `node tools/verify.js` is the loud
  // one, and it runs before a build rather than during development.
  if (localNameOverride() !== null) {
    console.log('    note: this build scans for "' + localNameOverride() +
      '" and cannot find a real car')
  }
})

function randomBytes (n) {
  return new Uint8Array(crypto.randomBytes(n))
}

function controllerWith (bleNameOverride) {
  const vehicle = createMockVehicle({ vin: VIN })
  const storage = createSettingsStore(createMemoryBackend())
  const privateKey = generatePrivateKey(randomBytes)
  const publicKey = derivePublicKey(privateKey)

  storage.setVin(VIN)
  storage.setKeyPair(privateKey, publicKey)
  storage.setKeyProvenance(PROVENANCE_STRONG)
  storage.setEnrolled(true)
  vehicle.enrol(publicKey)

  const factory = createFakeTransportFactory(vehicle)
  const controller = createController({
    storage,
    createTransport: factory,
    bleNameOverride,
    deriveSharedSecret: localSharedSecret
  })
  controller.begin()
  return { controller, factory }
}

test('the controller scans for the derived name by default', () => {
  const { controller, factory } = controllerWith('')

  controller.connect()

  assert.strictEqual(factory.current().deviceName, DERIVED)
})

test('a configured override is what the controller scans for', () => {
  const { controller, factory } = controllerWith('DESKTOP-4F2A')

  controller.connect()

  assert.strictEqual(factory.current().deviceName, 'DESKTOP-4F2A',
    'the override never reached the transport, so the mock car would never be found')
})

test('a scan that finds nothing names the override on screen', () => {
  // The symptom an override produces is identical to the car being parked
  // somewhere else, and the log is not visible from a wrist. This is the only
  // place the watch itself can say which of the two it is.
  const { controller, factory } = controllerWith('DESKTOP-4F2A')

  controller.connect()
  factory.current().simulateScanFailure()

  assert.ok(controller.detail.indexOf('DESKTOP-4F2A') >= 0,
    'nothing on screen distinguishes a wrong name from an absent car: ' + controller.detail)
})

test('a car that is genuinely absent is not blamed on an override', () => {
  const { controller, factory } = controllerWith('')

  controller.connect()
  factory.current().simulateScanFailure()

  assert.strictEqual(controller.detail, 'Car not found. Stand next to it and try again.')
})

test('changing the car re-scans under the same override', () => {
  // A VIN change tears the link down and reconnects. The override is not
  // derived from the VIN, so it has to survive that.
  const { controller, factory } = controllerWith('DESKTOP-4F2A')

  controller.connect()
  controller.setVin('5YJ30123456789XYZ')
  controller.connect()

  assert.strictEqual(factory.current().deviceName, 'DESKTOP-4F2A')
})
