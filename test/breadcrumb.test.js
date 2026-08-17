// The trail a restarted watch leaves behind.
//
// This exists for a fault that destroys its own evidence: the watchdog resets
// the device, so the screen, the console and the application's memory all go at
// once. The only account of the last moment is whatever had already been
// written to storage, which makes *when* it is written and cleared the whole
// of whether it can be believed.
//
// Two ways to get it wrong, and both would mislead rather than merely fail: a
// trail left behind after a clean run reports a crash that did not happen, and
// a trail cleared too early reports nothing for one that did.

import { test } from 'node:test'
import assert from 'node:assert'
import crypto from 'node:crypto'

import { createBreadcrumb } from '../lib/app/breadcrumb.js'
import { createController } from '../lib/app/controller.js'
import { createSettingsStore, createMemoryBackend } from '../lib/app/settings-store.js'
import { PROVENANCE_STRONG } from '../lib/app/identity.js'
import { createMockVehicle } from '../tools/mock-vehicle.js'
import { createFakeTransportFactory } from '../tools/fake-transport.js'
import { derivePublicKey, generatePrivateKey } from '../lib/crypto/p256.js'
import { localSharedSecret } from '../lib/tesla/session.js'

const VIN = '5YJ30123456789ABC'

function randomBytes (n) {
  return new Uint8Array(crypto.randomBytes(n))
}

function store () {
  return createSettingsStore(createMemoryBackend())
}

test('a disabled breadcrumb writes nothing at all', () => {
  // The default, and it has to stay free: every record() is a flash write, and
  // some land on Bluetooth callbacks.
  const storage = store()
  const trail = createBreadcrumb(storage, false)

  trail.record('opening the link', 120)

  assert.strictEqual(trail.enabled, false)
  assert.strictEqual(storage.getBreadcrumb(), null)
  assert.strictEqual(trail.take(), null)
})

test('an enabled breadcrumb records the step and how far in it happened', () => {
  const storage = store()
  const trail = createBreadcrumb(storage, true)

  trail.record('switching notifications on', 843)

  assert.strictEqual(storage.getBreadcrumb(), 'switching notifications on (+843ms)')
})

test('taking the breadcrumb reports it once and then forgets it', () => {
  // Otherwise the report follows its owner around for the rest of the day,
  // and a fault from this morning is still on screen this afternoon.
  const storage = store()
  const trail = createBreadcrumb(storage, true)
  trail.record('finding the profile on the car', 300)

  assert.strictEqual(trail.take(), 'finding the profile on the car (+300ms)')
  assert.strictEqual(trail.take(), null)
})

test('a storage that throws cannot break a connection attempt', () => {
  // The instrument must never become the fault. This runs mid-connection, on
  // a Bluetooth callback, on a device where a throw there is not survivable.
  const angry = {
    setBreadcrumb () { throw new Error('flash is full') },
    getBreadcrumb () { throw new Error('flash is unreadable') },
    clearBreadcrumb () { throw new Error('no') }
  }
  const trail = createBreadcrumb(angry, true)

  assert.doesNotThrow(() => trail.record('opening the link', 1))
  assert.doesNotThrow(() => trail.clear())
  assert.strictEqual(trail.take(), null)
})

function setup (breadcrumb) {
  const vehicle = createMockVehicle({ vin: VIN })
  const storage = store()
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
    breadcrumb,
    deriveSharedSecret: localSharedSecret
  })
  controller.begin()
  return { controller, factory, storage }
}

function settle (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms === undefined ? 40 : ms))
}

test('a connection in progress leaves a trail', async () => {
  // What the watch would leave behind if it restarted here.
  const { controller, storage } = setup(true)

  controller.connect()

  const left = storage.getBreadcrumb()
  assert.ok(left, 'nothing was recorded, so a reset here would be unaccounted for')
  assert.ok(/looking for|scanning/i.test(left), 'unhelpful trail: ' + left)
})

test('reaching the car clears the trail', async () => {
  // A link that came up is not a crash, and reporting one next launch would
  // send its owner looking for a fault that never happened.
  const { controller, storage } = setup(true)

  controller.connect()
  await settle()

  assert.strictEqual(storage.getBreadcrumb(), null,
    'a successful connection still looks like a crash')
  assert.strictEqual(controller.lastConnectStep(), null)
})

test('closing the app deliberately clears the trail', async () => {
  const { controller, storage } = setup(true)

  controller.connect()
  await settle()

  // The exact pair page/index.js onDestroy runs, in that order. Testing only
  // the first of the two is what let this through: the clear is undone by the
  // close that follows it, because closing emits its own state change straight
  // back into the recorder.
  controller.forgetConnectStep()
  controller.disconnect()

  assert.strictEqual(storage.getBreadcrumb(), null,
    'an ordinary app close left "' + storage.getBreadcrumb() + '" behind, which the next ' +
    'launch reports as a crash and then refuses to auto-connect because of')
  assert.strictEqual(controller.lastConnectStep(), null)
})

test('walking out of range is not a crash either', async () => {
  const { controller, factory, storage } = setup(true)

  controller.connect()
  await settle()
  factory.current().simulateDisconnect()

  assert.strictEqual(storage.getBreadcrumb(), null)
})

test('changing the car clears the trail with it', async () => {
  // setVin closes the transport to drop the old car, which is another way to
  // reach the same terminal state without going through disconnect().
  const { controller, storage } = setup(true)

  controller.connect()
  await settle()
  controller.setVin('5YJ30123456789XYZ')

  assert.strictEqual(storage.getBreadcrumb(), null)
})

test('disconnecting does not write the shutdown back into the trail', async () => {
  // The way an instrument like this lies. disconnect() clears the trail and
  // then closes the transport -- which emits its own state change, straight
  // back into the recorder, from inside the same call. Recorded, that would
  // leave "closed" behind after an ordinary exit, and the next launch would
  // report a crash that never happened and refuse to connect because of it.
  const { controller, storage } = setup(true)

  controller.connect()
  await settle()
  controller.disconnect()

  assert.strictEqual(storage.getBreadcrumb(), null,
    'a clean disconnect left a trail: ' + storage.getBreadcrumb())
})

test('a failed attempt is not reported as a crash either', async () => {
  // A failure the app survived long enough to report is not a fault this trail
  // is for; it already reached the screen.
  const { controller, factory, storage } = setup(true)

  controller.connect()
  factory.current().simulateScanFailure()

  assert.strictEqual(storage.getBreadcrumb(), null)
})

test('the trail covers the work the link coming up triggers', async () => {
  // READY is not the end of the risk. Everything the controller does in
  // response -- building the client, seeding the generator, reserving a nonce
  // block against flash, framing the handshake -- runs synchronously inside
  // the stack's own prepare callback, and that is the heaviest thing this app
  // asks of a native callback. Clearing the trail when the link came up would
  // blind it to precisely that window, which is the one worth watching.
  const { controller, storage } = setup(true)

  const written = []
  const realSet = storage.setBreadcrumb
  storage.setBreadcrumb = (value) => {
    written.push(value)
    realSet.call(storage, value)
  }

  controller.connect()
  await settle()

  assert.ok(written.some((entry) => /setting up the session/.test(entry)),
    'nothing marked the window between the link coming up and the session being ready: ' +
    written.join(' | '))
  // And it is gone again by the end, because the callback survived.
  assert.strictEqual(storage.getBreadcrumb(), null)
})

test('a trail from a previous run is reported once', () => {
  const { controller, storage } = setup(true)
  storage.setBreadcrumb('opening the link (+1200ms)')

  assert.strictEqual(controller.lastConnectStep(), 'opening the link (+1200ms)')
  assert.strictEqual(controller.lastConnectStep(), null, 'reported twice')
})

test('a build without the breadcrumb reports nothing to read', () => {
  const { controller, storage } = setup(false)

  controller.connect()

  assert.strictEqual(storage.getBreadcrumb(), null)
  assert.strictEqual(controller.lastConnectStep(), null)
})
