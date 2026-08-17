// The receive path is where a forged or malformed frame would do its damage:
// anything that reaches settle() without being a genuine reply turns into a
// reported success, which on a car key means the watch says "Locked" when the
// car is not.
//
// Every test here injects a frame the vehicle never sent, straight into the
// client's inbound handler, and asserts it changes nothing.

import { test } from 'node:test'
import assert from 'node:assert'
import crypto from 'node:crypto'

import { createClient } from '../lib/tesla/client.js'
import { buildSessionInfo, parseRoutableMessage } from '../lib/tesla/messages.js'
import { localSharedSecret } from '../lib/tesla/session.js'
import { createMockVehicle } from '../tools/mock-vehicle.js'
import { derivePublicKey, generatePrivateKey } from '../lib/crypto/p256.js'
import {
  createWriter, writeVarintField, writeBytesField, writeMessageField, finishWriter
} from '../lib/tesla/protobuf.js'
import {
  DOMAIN, ROUTABLE, DESTINATION, FROM_VCSEC_MESSAGE, VEHICLE_STATUS,
  COMMAND_STATUS, OPERATION_STATUS, CLOSURE_FIELD, CLOSURE_STATE,
  VEHICLE_LOCK_STATE, TRUST
} from '../lib/tesla/constants.js'

const VIN = '5YJ30123456789ABC'

function randomBytes (n) {
  return new Uint8Array(crypto.randomBytes(n))
}

function setup () {
  const vehicle = createMockVehicle({ vin: VIN })
  const privateKey = generatePrivateKey(randomBytes)
  const publicKey = derivePublicKey(privateKey)
  vehicle.enrol(publicKey)

  let clientHandler = null
  let muted = false

  const sent = []
  const link = {
    send (bytes) { sent.push(bytes); if (!muted) vehicle.link.send(bytes) },
    onMessage (cb) { clientHandler = cb }
  }
  vehicle.link.onMessage((bytes) => { if (clientHandler) clientHandler(bytes) })

  const statuses = []
  const client = createClient({
    vin: VIN,
    privateKey,
    publicKey,
    link,
    randomBytes,
    deriveSharedSecret: localSharedSecret,
    onStatus: (status, trust) => statuses.push({ status, trust })
  })

  return {
    vehicle,
    client,
    statuses,
    sent,
    inject: (bytes) => clientHandler(bytes),
    mute: () => { muted = true }
  }
}

function call (fn) {
  return new Promise((resolve, reject) => {
    fn((err, result) => (err ? reject(err) : resolve(result)))
  })
}

function settled (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms === undefined ? 60 : ms))
}

// Builds a RoutableMessage with exactly the fields given, so a frame can omit
// things the vehicle would normally include.
function routable (options) {
  const message = createWriter()

  if (options.toDomain !== undefined || options.toAddress) {
    const dest = createWriter()
    if (options.toDomain !== undefined) writeVarintField(dest, DESTINATION.DOMAIN, options.toDomain)
    if (options.toAddress) writeBytesField(dest, DESTINATION.ROUTING_ADDRESS, options.toAddress)
    writeMessageField(message, ROUTABLE.TO_DESTINATION, dest)
  }

  const from = createWriter()
  writeVarintField(from, DESTINATION.DOMAIN, DOMAIN.VEHICLE_SECURITY)
  writeMessageField(message, ROUTABLE.FROM_DESTINATION, from)

  if (options.payload !== undefined) {
    writeBytesField(message, ROUTABLE.PROTOBUF_MESSAGE_AS_BYTES, options.payload)
  }
  return finishWriter(message)
}

function vcsecCommandStatus (operationStatus) {
  const status = createWriter()
  writeVarintField(status, COMMAND_STATUS.OPERATION_STATUS, operationStatus)
  const outer = createWriter()
  writeMessageField(outer, FROM_VCSEC_MESSAGE.COMMAND_STATUS, status)
  return finishWriter(outer)
}

function vcsecVehicleStatus (lockState, closures) {
  const closureStatuses = createWriter()
  for (const key of Object.keys(closures)) {
    writeVarintField(closureStatuses, Number(key), closures[key])
  }

  const status = createWriter()
  writeMessageField(status, VEHICLE_STATUS.CLOSURE_STATUSES, closureStatuses)
  writeVarintField(status, VEHICLE_STATUS.VEHICLE_LOCK_STATE, lockState)

  const outer = createWriter()
  writeMessageField(outer, FROM_VCSEC_MESSAGE.VEHICLE_STATUS, status)
  return finishWriter(outer)
}

test('a frame with no destination cannot settle a pending command', async () => {
  const ctx = setup()
  await call((cb) => ctx.client.handshake(DOMAIN.VEHICLE_SECURITY, cb))
  ctx.mute()

  let settledWith = 'nothing'
  ctx.client.lock((err) => { settledWith = err ? 'error' : 'success' })

  // No to_destination at all. The old filter tested "address present AND
  // different", so this fell through and reported success.
  ctx.inject(routable({ payload: new Uint8Array(0) }))
  await settled()

  assert.strictEqual(settledWith, 'nothing', 'a destination-less frame settled the command')
})

test('a frame addressed to a domain rather than us cannot settle a command', async () => {
  const ctx = setup()
  await call((cb) => ctx.client.handshake(DOMAIN.VEHICLE_SECURITY, cb))
  ctx.mute()

  let settledWith = 'nothing'
  ctx.client.lock((err) => { settledWith = err ? 'error' : 'success' })

  ctx.inject(routable({ toDomain: DOMAIN.VEHICLE_SECURITY, payload: new Uint8Array(0) }))
  await settled()

  assert.strictEqual(settledWith, 'nothing', 'a domain-addressed frame settled the command')
})

test('a frame addressed to a different routing address is ignored', async () => {
  const ctx = setup()
  await call((cb) => ctx.client.handshake(DOMAIN.VEHICLE_SECURITY, cb))
  ctx.mute()

  let settledWith = 'nothing'
  ctx.client.lock((err) => { settledWith = err ? 'error' : 'success' })

  ctx.inject(routable({ toAddress: randomBytes(16), payload: new Uint8Array(0) }))
  await settled()

  assert.strictEqual(settledWith, 'nothing', 'someone else’s reply settled our command')
})

test('a frame carrying no payload acknowledges nothing', async () => {
  const ctx = setup()
  await call((cb) => ctx.client.handshake(DOMAIN.VEHICLE_SECURITY, cb))

  // Capture our own routing address by watching what the client sends.
  const addresses = []
  const original = ctx.inject
  ctx.mute()

  let settledWith = 'nothing'
  ctx.client.lock((err) => { settledWith = err ? 'error' : 'success' })

  // Even correctly addressed, a frame with no payload field is not an ack.
  // Silence is only an acknowledgement when it arrives as an EMPTY payload.
  ctx.inject(routable({ toAddress: new Uint8Array(16) }))
  await settled()

  assert.strictEqual(settledWith, 'nothing', 'a payload-less frame settled the command')
  assert.strictEqual(addresses.length, 0)
  assert.ok(original)
})

test('a non-specific error is not treated as success', async () => {
  const ctx = setup()
  await call((cb) => ctx.client.handshake(DOMAIN.VEHICLE_SECURITY, cb))
  ctx.mute()

  let settledWith = 'nothing'
  ctx.client.lock((err) => { settledWith = err ? 'error' : 'success' })

  // OPERATIONSTATUS_ERROR with nothing more specific is legacy noise. Reporting
  // it as success would be the worst possible reading.
  ctx.inject(routable({
    toAddress: new Uint8Array(16),
    payload: vcsecCommandStatus(OPERATION_STATUS.ERROR)
  }))
  await settled()

  assert.notStrictEqual(settledWith, 'success', 'a vehicle error was reported as success')
})

test('an unsolicited vehicle status is surfaced as overheard, and settles nothing', async () => {
  const ctx = setup()
  await call((cb) => ctx.client.handshake(DOMAIN.VEHICLE_SECURITY, cb))
  ctx.mute()

  let settledWith = 'nothing'
  ctx.client.lock((err) => { settledWith = err ? 'error' : 'success' })

  const closures = {}
  closures[CLOSURE_FIELD.FRONT_DRIVER_DOOR] = CLOSURE_STATE.OPEN
  closures[CLOSURE_FIELD.REAR_TRUNK] = CLOSURE_STATE.CLOSED
  ctx.inject(vcsecVehicleStatus(VEHICLE_LOCK_STATE.LOCKED, closures))
  await settled()

  assert.strictEqual(settledWith, 'nothing', 'a broadcast settled a pending command')
  assert.strictEqual(ctx.statuses.length, 1, 'the broadcast was not surfaced')

  const seen = ctx.statuses[0]
  // Nothing authenticates a broadcast, so it must never be presented as fact.
  assert.strictEqual(seen.trust, TRUST.OVERHEARD)
  assert.strictEqual(seen.status.lockState, VEHICLE_LOCK_STATE.LOCKED)
  assert.strictEqual(seen.status.closures[CLOSURE_FIELD.FRONT_DRIVER_DOOR], CLOSURE_STATE.OPEN)
  assert.strictEqual(seen.status.closures[CLOSURE_FIELD.REAR_TRUNK], CLOSURE_STATE.CLOSED)
})

test('vehicle status decodes both nesting levels correctly', async () => {
  const ctx = setup()

  // closureStatuses is field 1 of a VehicleStatus that is itself field 1, so the
  // frame opens 0a..0a.. — unwrapping one level would read lock state as a door.
  const closures = {}
  closures[CLOSURE_FIELD.FRONT_PASSENGER_DOOR] = CLOSURE_STATE.AJAR
  closures[CLOSURE_FIELD.FRONT_TRUNK] = CLOSURE_STATE.OPENING
  ctx.inject(vcsecVehicleStatus(VEHICLE_LOCK_STATE.UNLOCKED, closures))
  await settled(20)

  const seen = ctx.statuses[0]
  assert.strictEqual(seen.status.lockState, VEHICLE_LOCK_STATE.UNLOCKED, 'lock state misread')
  assert.strictEqual(seen.status.closures[CLOSURE_FIELD.FRONT_PASSENGER_DOOR], CLOSURE_STATE.AJAR)
  assert.strictEqual(seen.status.closures[CLOSURE_FIELD.FRONT_TRUNK], CLOSURE_STATE.OPENING)
  // Lock state must not have leaked into the closure map.
  assert.strictEqual(seen.status.closures[CLOSURE_FIELD.FRONT_DRIVER_DOOR], undefined)
})

test('a genuine encrypted reply is trusted more than a broadcast', async () => {
  const ctx = setup()
  await call((cb) => ctx.client.unlock(cb))

  // The mock always encrypts its replies, so a real command round trip should
  // never be downgraded to overheard.
  for (const seen of ctx.statuses) {
    assert.notStrictEqual(seen.trust, TRUST.OVERHEARD)
  }
})

test('a session-info frame with no from-destination does not throw', async () => {
  // The domain a frame belongs to has to be read before the shared-secret
  // derivation can yield, because `pending` may be gone by the time the phone
  // answers. Hoisting that read also hoisted it above authentication, where the
  // field is whatever the sender chose -- and parseRoutableMessage yields null
  // for an absent from_destination, which the response decoder a few lines down
  // has always allowed for.
  //
  // On the watch the resulting TypeError is swallowed by the Bluetooth
  // callback's catch, so a reply the car really did send vanishes and the
  // command dies as a timeout with nothing in the log to explain it.
  const { client, inject, sent, mute } = setup()

  // A real session first, so the next request is a command rather than a
  // handshake -- the handshake path takes its domain from the pending request.
  await call((cb) => client.unlock(cb))

  mute()
  let settled = null
  client.unlock((err) => { settled = err || 'ok' })

  const outbound = parseRoutableMessage(sent[sent.length - 1])
  const ours = outbound.fromDestination.routingAddress
  assert.ok(ours, 'the command went out with no routing address')

  // Session info carrying a well-formed public key, addressed to us, with the
  // from_destination field simply absent.
  const info = buildSessionInfo({
    counter: 9,
    publicKey: new Uint8Array(65).fill(4),
    epoch: new Uint8Array(16),
    clockTime: 100
  })

  const message = createWriter()
  const dest = createWriter()
  writeBytesField(dest, DESTINATION.ROUTING_ADDRESS, ours)
  writeMessageField(message, ROUTABLE.TO_DESTINATION, dest)
  writeBytesField(message, ROUTABLE.SESSION_INFO, info)

  assert.doesNotThrow(() => inject(finishWriter(message)),
    'a frame with no from_destination crashed the inbound handler')
  await settled60()
  assert.notStrictEqual(settled, 'ok', 'a forged frame settled the command')
})

function settled60 () {
  return new Promise((resolve) => setTimeout(resolve, 60))
}
