// Pressing a button while the app is still talking to the car.
//
// The app reads the car's status after every command, because VCSEC
// acknowledges a successful action with silence and a status read is the only
// way to learn whether anything moved. That read is fired from inside the
// command's own callback -- so the screen returns to "Unlock sent" and invites
// the next press while the read is still crossing the air.
//
// Only one request can be in flight: every command carries a counter the
// vehicle requires to increase, so two of them cannot be told apart. The press
// was therefore refused with "a request is already in flight", which is a
// sentence about this app's internals shown to somebody standing at a car.
//
// None of the existing tests could see it. Both the mock vehicle and the socket
// answer in about a millisecond, so the window is never open when the next line
// of a test runs; over Bluetooth it is most of a second. These tests put the
// latency back.

import { test } from 'node:test'
import assert from 'node:assert'
import crypto from 'node:crypto'

import { createController, STATE } from '../lib/app/controller.js'
import { createSettingsStore, createMemoryBackend } from '../lib/app/settings-store.js'
import { PROVENANCE_STRONG } from '../lib/app/identity.js'
import { createMockVehicle } from '../tools/mock-vehicle.js'
import { STATE as BLE_STATE } from '../lib/zepp/ble-states.js'
import { derivePublicKey, generatePrivateKey } from '../lib/crypto/p256.js'
import { localSharedSecret } from '../lib/tesla/session.js'

const VIN = '5YJ30123456789ABC'
const LATENCY_MS = 60

function randomBytes (n) {
  return new Uint8Array(crypto.randomBytes(n))
}

function settle (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms === undefined ? 400 : ms))
}

// A transport that takes time, which is the whole point: the fault under test
// only exists in the gap between a message being sent and its answer arriving.
function slowTransportFactory (vehicle) {
  let current = null

  const factory = function (options) {
    const onState = options.onState || function () {}
    let messageHandler = null

    vehicle.link.onMessage((message) => {
      setTimeout(() => { if (messageHandler) messageHandler(message) }, LATENCY_MS)
    })

    current = {
      state: BLE_STATE.IDLE,
      get rssi () { return -50 },
      connect () {
        onState(BLE_STATE.SCANNING)
        setTimeout(() => {
          current.state = BLE_STATE.READY
          onState(BLE_STATE.READY)
        }, 2)
      },
      send (message) { setTimeout(() => vehicle.link.send(message), LATENCY_MS) },
      onMessage (handler) { messageHandler = handler },
      close () { onState(BLE_STATE.IDLE, 'closed') }
    }
    return current
  }

  factory.current = () => current
  return factory
}

function setup () {
  const vehicle = createMockVehicle({ vin: VIN })
  const storage = createSettingsStore(createMemoryBackend())
  const privateKey = generatePrivateKey(randomBytes)
  const publicKey = derivePublicKey(privateKey)

  storage.setVin(VIN)
  storage.setKeyPair(privateKey, publicKey)
  storage.setKeyProvenance(PROVENANCE_STRONG)
  storage.setEnrolled(true)
  vehicle.enrol(publicKey)

  const controller = createController({
    storage,
    createTransport: slowTransportFactory(vehicle),
    deriveSharedSecret: localSharedSecret
  })
  controller.begin()
  return { controller, vehicle }
}

// Waits for a command to report back, which is the moment the screen says
// "<command> sent" and offers the buttons again.
function reachesReady (controller) {
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (controller.state === STATE.READY && / sent$/.test(controller.detail)) {
        clearInterval(poll)
        resolve()
      }
    }, 5)
  })
}

function commands (vehicle) {
  return vehicle.events.filter((e) => e.type === 'rke').length
}

test('a press the screen invited is not refused', async () => {
  const { controller, vehicle } = setup()
  controller.connect()
  await settle(120)

  controller.unlock()
  await reachesReady(controller)

  // Exactly what the wearer does: the screen says "Unlock sent" and shows the
  // Lock button, so they press it. The status read fired a moment ago is still
  // outstanding at this point -- that is the race.
  controller.lock()
  await settle()

  assert.notStrictEqual(controller.state, STATE.ERROR,
    'the press was refused: ' + controller.detail)
  assert.strictEqual(commands(vehicle), 2, 'the car never received the second command')
})

test('the status read gives way rather than the command', async () => {
  // Which of the two yields is the decision. A status read is this app asking
  // a question of its own accord; a command is its owner standing at a car.
  const { controller, vehicle } = setup()
  controller.connect()
  await settle(120)

  controller.unlock()
  await reachesReady(controller)
  controller.lock()
  await settle()

  assert.strictEqual(controller.state, STATE.READY)
  assert.match(controller.detail, /Lock sent/)
  assert.strictEqual(commands(vehicle), 2)
})

test('the status the car reports still catches up', async () => {
  // The superseded read must not leave the display stale for good: the command
  // that took its slot reports back, and fires a read of its own.
  const { controller } = setup()
  controller.connect()
  await settle(120)

  controller.unlock()
  await reachesReady(controller)
  controller.lock()
  await settle(600)

  assert.ok(controller.vehicleStatus, 'no status was ever obtained')
  assert.strictEqual(controller.vehicleStatus.lockState, 1, 'the display kept a stale lock state')
})

test('a second press while a command is running says what is running', async () => {
  // Not "Not connected", which is what it used to say: the car is right there
  // and the first command is on its way to it.
  const { controller } = setup()
  controller.connect()
  await settle(120)

  controller.unlock()
  await settle(10)
  assert.strictEqual(controller.state, STATE.BUSY, 'precondition: a command is running')

  controller.lock()
  assert.notStrictEqual(controller.state, STATE.ERROR, 'reported a fault for an ordinary press')
  assert.match(controller.detail, /Still sending Unlock/)

  // And again, without the caption eating itself.
  controller.lock()
  assert.match(controller.detail, /^Still sending Unlock…$/)

  await settle()
})
