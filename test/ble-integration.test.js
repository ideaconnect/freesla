// The same protocol exercise as integration.test.js, but forced through
// 20-byte BLE fragments. A message that survives here has been split, written,
// reassembled from its length prefix, and authenticated -- which is the path it
// takes on the watch.

import { test } from 'node:test'
import assert from 'node:assert'
import crypto from 'node:crypto'

import { createClient } from '../lib/tesla/client.js'
import { localSharedSecret } from '../lib/tesla/session.js'
import { createMockVehicle } from '../tools/mock-vehicle.js'
import { createSimulatedBleLink } from '../tools/ble-link.js'
import { derivePublicKey, generatePrivateKey } from '../lib/crypto/p256.js'
import { DOMAIN, RKE_ACTION } from '../lib/tesla/constants.js'

const VIN = '5YJ30123456789ABC'

function randomBytes (n) {
  return new Uint8Array(crypto.randomBytes(n))
}

function call (fn) {
  return new Promise((resolve, reject) => {
    fn((err, result) => (err ? reject(err) : resolve(result)))
  })
}

function setup (chunkSize) {
  const vehicle = createMockVehicle({ vin: VIN })
  const privateKey = generatePrivateKey(randomBytes)
  const publicKey = derivePublicKey(privateKey)
  vehicle.enrol(publicKey)

  const stats = { chunks: 0, messages: 0 }
  const link = createSimulatedBleLink(vehicle.link, {
    chunkSize,
    onTraffic ({ chunks }) {
      stats.chunks += chunks
      stats.messages += 1
    }
  })

  const client = createClient({ vin: VIN, privateKey, publicKey, link, randomBytes, deriveSharedSecret: localSharedSecret })
  return { vehicle, client, stats }
}

test('a full command survives fragmentation at the default mtu', async () => {
  const { client, vehicle, stats } = setup(20)

  await call((cb) => client.unlock(cb))

  const actions = vehicle.events.filter((e) => e.type === 'rke')
  assert.strictEqual(actions.length, 1)
  assert.strictEqual(actions[0].action, RKE_ACTION.UNLOCK)
  assert.ok(stats.chunks > stats.messages * 3,
    'messages were not actually fragmented (' + stats.chunks + ' chunks)')
})

test('the protocol works across a range of mtu sizes', async () => {
  // Small sizes stress reassembly hardest: a 3-byte payload splits the length
  // prefix across writes.
  for (const chunkSize of [3, 7, 20, 23, 64, 185, 512]) {
    const { client, vehicle } = setup(chunkSize)

    await call((cb) => client.unlock(cb))
    assert.strictEqual(
      vehicle.events.filter((e) => e.type === 'rke').length, 1,
      'failed at chunk size ' + chunkSize
    )
  }
})

test('a long run of commands stays in sync over a fragmented link', async () => {
  const { client, vehicle } = setup(20)

  await call((cb) => client.handshake(DOMAIN.VEHICLE_SECURITY, cb))
  for (let i = 0; i < 8; i++) {
    await call((cb) => (i % 2 === 0 ? client.unlock(cb) : client.lock(cb)))
  }

  const actions = vehicle.events.filter((e) => e.type === 'rke')
  assert.strictEqual(actions.length, 8)
  assert.strictEqual(actions[0].action, RKE_ACTION.UNLOCK)
  assert.strictEqual(actions[1].action, RKE_ACTION.LOCK)
  assert.strictEqual(actions[7].action, RKE_ACTION.LOCK)
})

test('enrolment and recovery both work through fragmentation', async () => {
  const vehicle = createMockVehicle({ vin: VIN })
  const privateKey = generatePrivateKey(randomBytes)
  const publicKey = derivePublicKey(privateKey)

  const link = createSimulatedBleLink(vehicle.link, { chunkSize: 20 })
  const client = createClient({ vin: VIN, privateKey, publicKey, link, randomBytes, deriveSharedSecret: localSharedSecret })

  client.requestEnrolment()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.ok(!vehicle.isEnrolled(publicKey), 'enrolled without a keycard tap')

  vehicle.tapKeycard()
  await call((cb) => client.unlock(cb))

  vehicle.reboot()
  await call((cb) => client.lock(cb))

  assert.strictEqual(vehicle.events.filter((e) => e.type === 'rke').length, 2)
})
