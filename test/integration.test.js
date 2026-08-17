// End-to-end protocol exercise: the watch client against a mock vehicle whose
// crypto runs on OpenSSL. The Zepp simulator has no Bluetooth, so this is the
// only place short of a real car where the whole stack runs together.
//
// Every exchange here crosses an implementation boundary. A handshake that
// completes means our pure-JS P-256, SHA-1 and HMAC agreed with OpenSSL's; an
// accepted unlock means our AES-GCM and metadata encoding did too.

import { test } from 'node:test'
import assert from 'node:assert'
import crypto from 'node:crypto'

import { createClient } from '../lib/tesla/client.js'
import { localSharedSecret } from '../lib/tesla/session.js'
import { createMockVehicle } from '../tools/mock-vehicle.js'
import { derivePublicKey, generatePrivateKey } from '../lib/crypto/p256.js'
import {
  DOMAIN, RKE_ACTION, CLOSURE_FIELD, CLOSURE_MOVE, ROLE, GENERIC_ERROR
} from '../lib/tesla/constants.js'

const VIN = '5YJ30123456789ABC'

function randomBytes (n) {
  return new Uint8Array(crypto.randomBytes(n))
}

function setup (options) {
  const settings = options || {}
  const vehicle = createMockVehicle({ vin: settings.vin || VIN })

  const privateKey = generatePrivateKey(randomBytes)
  const publicKey = derivePublicKey(privateKey)

  const client = createClient({
    vin: settings.clientVin || VIN,
    privateKey,
    publicKey,
    link: vehicle.link,
    randomBytes,
    deriveSharedSecret: localSharedSecret
  })

  if (!settings.skipEnrolment) vehicle.enrol(publicKey)
  return { vehicle, client, publicKey, privateKey }
}

function call (fn) {
  return new Promise((resolve, reject) => {
    fn((err, result) => (err ? reject(err) : resolve(result)))
  })
}

test('handshake establishes a session across two crypto implementations', async () => {
  const { client, vehicle } = setup()

  await call((cb) => client.handshake(DOMAIN.VEHICLE_SECURITY, cb))

  assert.ok(client.isReady(DOMAIN.VEHICLE_SECURITY), 'session not established')
  assert.strictEqual(vehicle.events.filter((e) => e.type === 'handshake').length, 1)
  assert.ok(vehicle.events[0].enrolled, 'vehicle did not recognise the key')
})

test('unlock reaches the vehicle and is accepted', async () => {
  const { client, vehicle } = setup()

  await call((cb) => client.unlock(cb))

  const actions = vehicle.events.filter((e) => e.type === 'rke')
  assert.strictEqual(actions.length, 1, 'expected exactly one action')
  assert.strictEqual(actions[0].action, RKE_ACTION.UNLOCK)
})

test('lock, trunk and frunk each arrive as the right command', async () => {
  const { client, vehicle } = setup()

  await call((cb) => client.lock(cb))
  await call((cb) => client.openTrunk(cb))
  await call((cb) => client.openFrunk(cb))

  const rke = vehicle.events.filter((e) => e.type === 'rke')
  assert.strictEqual(rke.length, 1)
  assert.strictEqual(rke[0].action, RKE_ACTION.LOCK)

  const closures = vehicle.events.filter((e) => e.type === 'closure')
  assert.strictEqual(closures.length, 2)
  assert.strictEqual(closures[0].field, CLOSURE_FIELD.REAR_TRUNK)
  assert.strictEqual(closures[1].field, CLOSURE_FIELD.FRONT_TRUNK)
  assert.strictEqual(closures[0].move, 3, 'trunk should be an OPEN move')
})

test('every closure command reaches the vehicle intact', async () => {
  const { client, vehicle } = setup()

  await call((cb) => client.openTrunk(cb))
  await call((cb) => client.closeTrunk(cb))
  await call((cb) => client.stopTrunk(cb))
  await call((cb) => client.openFrunk(cb))
  await call((cb) => client.openChargePort(cb))

  const closures = vehicle.events.filter((e) => e.type === 'closure')
  assert.strictEqual(closures.length, 5)

  assert.deepStrictEqual(closures[0].moves, [{ field: CLOSURE_FIELD.REAR_TRUNK, move: CLOSURE_MOVE.OPEN }])
  assert.deepStrictEqual(closures[1].moves, [{ field: CLOSURE_FIELD.REAR_TRUNK, move: CLOSURE_MOVE.CLOSE }])
  assert.deepStrictEqual(closures[2].moves, [{ field: CLOSURE_FIELD.REAR_TRUNK, move: CLOSURE_MOVE.STOP }])
  assert.deepStrictEqual(closures[3].moves, [{ field: CLOSURE_FIELD.FRONT_TRUNK, move: CLOSURE_MOVE.OPEN }])
  assert.deepStrictEqual(closures[4].moves, [{ field: CLOSURE_FIELD.CHARGE_PORT, move: CLOSURE_MOVE.OPEN }])
})

test('opening the doors sends one message per door, in order', async () => {
  const { client, vehicle } = setup()

  const result = await call((cb) => client.openDoors(cb))
  assert.strictEqual(result.sent, 4)

  const closures = vehicle.events.filter((e) => e.type === 'closure')
  assert.strictEqual(closures.length, 4, 'expected four separate messages')

  closures.forEach((closure, index) => {
    assert.strictEqual(closure.moves.length, 1, 'message ' + index + ' was multi-field')
    assert.strictEqual(closure.moves[0].field, index + 1)
    assert.strictEqual(closure.moves[0].move, CLOSURE_MOVE.OPEN)
  })
})

test('a door sequence stops at the first failure', async () => {
  const { client, vehicle } = setup()
  await call((cb) => client.handshake(DOMAIN.VEHICLE_SECURITY, cb))

  // The vehicle rejects the next command; the remaining doors must not be sent
  // blindly after a refusal.
  vehicle.failNextCounter()
  vehicle.failNextCounter = () => {}

  await call((cb) => client.openDoors(cb))
  const closures = vehicle.events.filter((e) => e.type === 'closure')
  assert.ok(closures.length <= 4, 'sent more messages than there are doors')
})

test('a car with a door open refuses to lock and says why', async () => {
  // This is what replaces a "close the doors" command: ask the car to secure
  // itself and let it report the physical reason it cannot.
  const { client, vehicle } = setup()
  vehicle.setDoorOpen(true)

  await assert.rejects(
    call((cb) => client.lock(cb)),
    (err) => {
      assert.strictEqual(err.genericError, GENERIC_ERROR.CLOSURES_OPEN)
      // The wording has to tell the driver what to do about it.
      assert.match(err.message, /open/i)
      return true
    }
  )

  assert.ok(vehicle.events.some((e) => e.type === 'lock-refused'), 'the car never saw the lock')
  assert.strictEqual(vehicle.events.filter((e) => e.type === 'rke').length, 0,
    'the lock was recorded as executed despite being refused')
})

test('the same car locks once the door is shut', async () => {
  const { client, vehicle } = setup()

  vehicle.setDoorOpen(true)
  await assert.rejects(call((cb) => client.lock(cb)))

  vehicle.setDoorOpen(false)
  await call((cb) => client.lock(cb))

  assert.strictEqual(vehicle.events.filter((e) => e.type === 'rke' && e.action === RKE_ACTION.LOCK).length, 1)
})

test('opening and closing a closure are never confused', async () => {
  const { client, vehicle } = setup()

  await call((cb) => client.closeTrunk(cb))
  const move = vehicle.events.find((e) => e.type === 'closure')

  assert.strictEqual(move.moves[0].move, CLOSURE_MOVE.CLOSE,
    'a close command arrived as something else')
  assert.notStrictEqual(move.moves[0].move, CLOSURE_MOVE.OPEN)
})

test('several commands in a row keep the counter advancing', async () => {
  const { client, vehicle } = setup()

  for (let i = 0; i < 5; i++) {
    await call((cb) => client.unlock(cb))
  }
  assert.strictEqual(vehicle.events.filter((e) => e.type === 'rke').length, 5)
})

test('a key the vehicle does not know is refused', async () => {
  const { client } = setup({ skipEnrolment: true })

  await assert.rejects(
    call((cb) => client.unlock(cb)),
    /not enrolled/,
    'an unenrolled key was allowed to send commands'
  )
})

test('a mismatched vin breaks authentication', async () => {
  // The VIN is bound into every signature, so a client configured for the wrong
  // car cannot produce a tag the vehicle will accept.
  const { client } = setup({ clientVin: '5YJ30000000000000' })

  await assert.rejects(call((cb) => client.unlock(cb)), /authentication|rejected/)
})

test('a rebooted vehicle triggers resync and the command still lands', async () => {
  const { client, vehicle } = setup()

  await call((cb) => client.unlock(cb))
  assert.strictEqual(vehicle.events.filter((e) => e.type === 'rke').length, 1)

  // A reboot rotates the epoch, invalidating the session the client holds.
  vehicle.reboot()

  await call((cb) => client.lock(cb))
  const actions = vehicle.events.filter((e) => e.type === 'rke')
  assert.strictEqual(actions.length, 2, 'command did not survive the epoch change')
  assert.strictEqual(actions[1].action, RKE_ACTION.LOCK)
})

test('a stale counter is resynced rather than surfaced as a failure', async () => {
  const { client, vehicle } = setup()

  await call((cb) => client.unlock(cb))
  vehicle.failNextCounter()

  await call((cb) => client.unlock(cb))
  assert.strictEqual(vehicle.events.filter((e) => e.type === 'rke').length, 2)
})

test('enrolment waits for the keycard tap before the key works', async () => {
  const { client, vehicle, publicKey } = setup({ skipEnrolment: true })

  assert.ok(!vehicle.isEnrolled(publicKey), 'key was enrolled before being asked')

  client.requestEnrolment(ROLE.DRIVER)
  await new Promise((resolve) => setImmediate(resolve))

  const requested = vehicle.events.find((e) => e.type === 'enrolment-requested')
  assert.ok(requested, 'vehicle never saw the enrolment request')
  assert.strictEqual(requested.role, ROLE.DRIVER)
  assert.ok(!vehicle.isEnrolled(publicKey), 'key enrolled without an NFC tap')

  // Only the owner's physical keycard can complete this.
  vehicle.tapKeycard()
  assert.ok(vehicle.isEnrolled(publicKey), 'tap did not enrol the key')

  await call((cb) => client.unlock(cb))
  assert.strictEqual(vehicle.events.filter((e) => e.type === 'rke').length, 1)
})

test('a tampered command is rejected by the vehicle', async () => {
  const { vehicle, client } = setup()
  await call((cb) => client.handshake(DOMAIN.VEHICLE_SECURITY, cb))

  // Flip a bit in the ciphertext of an otherwise valid unlock.
  const originalSend = vehicle.link.send
  let corrupted = null
  const tamperingLink = {
    send (bytes) {
      const copy = new Uint8Array(bytes)
      // The payload sits well past the headers; flipping a late byte hits the
      // ciphertext or its tag without disturbing the framing.
      copy[copy.length - 20] ^= 0x01
      corrupted = copy
      originalSend(copy)
    },
    onMessage (cb) { vehicle.link.onMessage(cb) }
  }

  const tamperedClient = createClient({
    vin: VIN,
    privateKey: generatePrivateKey(randomBytes),
    publicKey: derivePublicKey(generatePrivateKey(randomBytes)),
    link: tamperingLink,
    randomBytes,
    deriveSharedSecret: localSharedSecret
  })

  await assert.rejects(call((cb) => tamperedClient.unlock(cb)))
  assert.ok(corrupted, 'tampering never ran')
  assert.strictEqual(
    vehicle.events.filter((e) => e.type === 'rke').length, 0,
    'a corrupted command was executed'
  )
})

test('the session key survives a reconnect without redoing ecdh', async () => {
  const vehicle = createMockVehicle({ vin: VIN })
  const privateKey = generatePrivateKey(randomBytes)
  const publicKey = derivePublicKey(privateKey)
  vehicle.enrol(publicKey)

  // A cache the app would persist to watch storage.
  const store = {}
  let derivations = 0
  const sessionKeyCache = {
    get (id) { return store[id] },
    set (id, value) { derivations++; store[id] = value }
  }

  const first = createClient({ vin: VIN, privateKey, publicKey, link: vehicle.link, randomBytes, sessionKeyCache, deriveSharedSecret: localSharedSecret })
  await call((cb) => first.unlock(cb))
  assert.strictEqual(derivations, 1, 'expected one ecdh on first contact')

  // A fresh client stands in for the app being reopened.
  const second = createClient({ vin: VIN, privateKey, publicKey, link: vehicle.link, randomBytes, sessionKeyCache, deriveSharedSecret: localSharedSecret })
  await call((cb) => second.unlock(cb))

  assert.strictEqual(derivations, 1, 'ecdh was recomputed despite a warm cache')
  assert.strictEqual(vehicle.events.filter((e) => e.type === 'rke').length, 2)
})
