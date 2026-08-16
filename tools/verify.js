// Runnable end-to-end demonstration against the mock vehicle.
//
//   node tools/verify.js
//
// Walks the complete lifecycle a real watch goes through -- key generation,
// enrolment behind an NFC tap, handshake, and commands -- printing every byte
// that crosses the simulated BLE link. The Zepp simulator has no Bluetooth, so
// this is where the protocol is checked.

import crypto from 'node:crypto'

import { createClient } from '../lib/tesla/client.js'
import { createMockVehicle } from './mock-vehicle.js'
import { createSimulatedBleLink } from './ble-link.js'
import { derivePublicKey, generatePrivateKey } from '../lib/crypto/p256.js'
import { vehicleLocalName } from '../lib/tesla/messages.js'
import { DOMAIN, ROLE, KEY_FORM_FACTOR } from '../lib/tesla/constants.js'

const VIN = process.argv[2] || '5YJ30123456789ABC'

function randomBytes (n) {
  return new Uint8Array(crypto.randomBytes(n))
}

function hex (bytes, limit) {
  const max = limit === undefined ? bytes.length : Math.min(limit, bytes.length)
  let out = ''
  for (let i = 0; i < max; i++) {
    out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16)
    if ((i + 1) % 2 === 0) out += ' '
  }
  if (max < bytes.length) out += '… (' + bytes.length + ' bytes)'
  return out.trim()
}

function heading (text) {
  console.log('\n\x1b[1m' + text + '\x1b[0m')
  console.log('─'.repeat(Math.max(text.length, 60)))
}

function step (text) {
  console.log('  ' + text)
}

function ok (text) {
  console.log('  \x1b[32m✓\x1b[0m ' + text)
}

function fail (text) {
  console.log('  \x1b[31m✗\x1b[0m ' + text)
}

function call (fn) {
  return new Promise((resolve, reject) => {
    fn((err, result) => (err ? reject(err) : resolve(result)))
  })
}

function run () {
  heading('Freesla protocol verification')
  step('VIN                  ' + VIN)
  step('Advertised BLE name  ' + vehicleLocalName(VIN))
  step('GATT service         00000211-b2d1-43f0-9b88-960cebf8b91e')

  heading('1. Generating the watch key')
  const started = Date.now()
  const privateKey = generatePrivateKey(randomBytes)
  const publicKey = derivePublicKey(privateKey)
  const elapsed = Date.now() - started

  ok('P-256 keypair generated in ' + elapsed + ' ms (pure JS, no BigInt)')
  step('public key  ' + hex(publicKey, 16))
  step('The private key never leaves the watch.')

  heading('2. Connecting over simulated BLE')
  const vehicle = createMockVehicle({ vin: VIN })

  let txCount = 0
  let rxCount = 0
  let chunkCount = 0

  const link = createSimulatedBleLink(vehicle.link, {
    chunkSize: 20,
    onTraffic ({ direction, message, chunks }) {
      chunkCount += chunks
      if (direction === 'tx') txCount++
      else rxCount++
      const arrow = direction === 'tx' ? '→ watch to car ' : '← car to watch '
      console.log('  ' + arrow + String(message.length).padStart(4) + ' bytes in ' +
        chunks + ' BLE write' + (chunks === 1 ? '' : 's'))
      console.log('      ' + hex(message, 24))
    }
  })

  const client = createClient({ vin: VIN, privateKey, publicKey, link, randomBytes })
  step('MTU payload 20 bytes, messages fragmented and reassembled')

  heading('3. Enrolling the key')
  step('Sending an add-key request…')
  client.requestEnrolment(ROLE.DRIVER, KEY_FORM_FACTOR.ANDROID_DEVICE)

  return delay(60)
    .then(() => {
      if (vehicle.isEnrolled(publicKey)) {
        fail('key was enrolled without an NFC tap — that would be a security hole')
        process.exitCode = 1
        return
      }
      ok('Car is waiting for authorisation; the key is NOT yet valid')
      step('A real car now needs an existing key card tapped on the console.')
      step('Nothing the watch can send substitutes for that tap.')

      step('Simulating the owner tapping their key card…')
      vehicle.tapKeycard()
      ok('Key enrolled')
    })
    .then(() => {
      heading('4. Handshake')
      return call((cb) => client.handshake(DOMAIN.VEHICLE_SECURITY, cb))
    })
    .then(() => {
      ok('Session established')
      step('ECDH shared secret computed by our JS on one side and OpenSSL on the other')
      step('Session key = SHA1(shared X)[0:16]; verified by HMAC over the session info')

      heading('5. Commands')
      return call((cb) => client.unlock(cb))
    })
    .then(() => {
      ok('Unlock accepted')
      return call((cb) => client.lock(cb))
    })
    .then(() => {
      ok('Lock accepted')
      return call((cb) => client.openTrunk(cb))
    })
    .then(() => {
      ok('Trunk accepted')

      heading('6. Recovery')
      step('Rebooting the car, which rotates its epoch and voids the session…')
      vehicle.reboot()
      return call((cb) => client.unlock(cb))
    })
    .then(() => {
      ok('Command resynced and succeeded after the epoch change')

      heading('Summary')
      const actions = vehicle.events.filter((e) => e.type === 'rke' || e.type === 'closure')
      step('Messages sent      ' + txCount)
      step('Messages received  ' + rxCount)
      step('BLE writes         ' + chunkCount + ' (20-byte fragments)')
      step('Actions executed   ' + actions.length)
      for (const action of actions) {
        step('  · ' + (action.type === 'rke' ? 'RKE action ' + action.action
          : 'closure field ' + action.field + ' move ' + action.move))
      }
      console.log('')
      ok('Protocol verified end to end against a vehicle using OpenSSL crypto.')
      console.log('')
    })
    .catch((err) => {
      fail(err.message)
      console.error(err)
      process.exitCode = 1
    })
}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

run()
