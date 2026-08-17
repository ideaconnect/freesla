// The watch's client against the C# mock car, over a socket.
//
// tools/mock-vehicle.js is JavaScript talking to JavaScript in one process: both
// halves share this repository's assumptions, and a mistake both make cancels
// out. mock-car/ is another language, another crypto library and another TLV
// encoder in another process, so these tests are where such a mistake shows up.
//
// They skip themselves when mock-car has not been built, because building it
// needs a .NET SDK and `npm test` must not.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { findMockCar, startMockCar, buildClient, call, randomBytes } from './helpers/mock-car.js'
import { generatePrivateKey, derivePublicKey } from '../lib/crypto/p256.js'
import { DOMAIN, ROLE, KEY_FORM_FACTOR, CLOSURE_FIELD, CLOSURE_STATE, VEHICLE_LOCK_STATE, TRUST } from '../lib/tesla/constants.js'

const VIN = '5YJ30123456789ABC'
const executable = findMockCar()

describe('the C# mock car', { skip: executable ? false : 'mock-car is not built (dotnet build mock-car)' }, () => {
  const keys = {}

  before(() => {
    keys.privateKey = generatePrivateKey(randomBytes)
    keys.publicKey = derivePublicKey(keys.privateKey)
  })

  // One car for the whole run, enrolled once, so the tests read as a sequence a
  // real key goes through rather than a set of unrelated fixtures.
  describe('a key being enrolled and used', () => {
    let car = null
    let socket = null
    let client = null
    let lastStatus = null

    before(async () => {
      car = await startMockCar({ executable, vin: VIN, port: 7101 })
      const connection = await car.connect()
      socket = connection.socket
      client = buildClient(VIN, connection.link, keys, (status, trust) => {
        lastStatus = { status, trust }
      })
    })

    after(async () => {
      socket?.destroy()
      await car?.stop()
    })

    test('a key the car does not know cannot open a session', async () => {
      await assert.rejects(
        () => call((cb) => client.handshake(DOMAIN.VEHICLE_SECURITY, cb)),
        /not enrolled/)
    })

    test('enrolment waits for the keycard tap', async () => {
      client.requestEnrolment(ROLE.DRIVER, KEY_FORM_FACTOR.ANDROID_DEVICE)
      await new Promise((resolve) => setTimeout(resolve, 300))

      // Still refused: sending the request is not what authorises it.
      client.reset()
      await assert.rejects(
        () => call((cb) => client.handshake(DOMAIN.VEHICLE_SECURITY, cb)),
        /not enrolled/)

      await car.press('k')
      client.reset()
      await call((cb) => client.handshake(DOMAIN.VEHICLE_SECURITY, cb))
      assert.equal(client.isReady(DOMAIN.VEHICLE_SECURITY), true)
    })

    test('commands are accepted and change the car', async () => {
      await call((cb) => client.unlock(cb))
      await call((cb) => client.openTrunk(cb))

      lastStatus = null
      await call((cb) => client.requestVehicleStatus(cb))
      assert.ok(lastStatus, 'the car sent no status')
      assert.equal(lastStatus.trust, TRUST.VERIFIED)
      assert.equal(lastStatus.status.closures[CLOSURE_FIELD.REAR_TRUNK], CLOSURE_STATE.OPEN)
      assert.equal(lastStatus.status.lockState, VEHICLE_LOCK_STATE.UNLOCKED)
    })

    test('a car with something open refuses to lock, physically not cryptographically', async () => {
      await assert.rejects(() => call((cb) => client.lock(cb)), /still open/)

      await car.press('c')
      await call((cb) => client.lock(cb))

      lastStatus = null
      await call((cb) => client.requestVehicleStatus(cb))
      assert.equal(lastStatus.status.lockState, VEHICLE_LOCK_STATE.LOCKED)
    })

    test('an unsolicited status frame is taken as overheard, not trusted', async () => {
      lastStatus = null
      await car.press('b')
      await new Promise((resolve) => setTimeout(resolve, 200))

      assert.ok(lastStatus, 'the broadcast never arrived')
      // Nothing signs a broadcast, nothing binds it to a session, and anyone in
      // radio range can send one. The client must say so.
      assert.equal(lastStatus.trust, TRUST.OVERHEARD)
      assert.equal(lastStatus.status.lockState, VEHICLE_LOCK_STATE.LOCKED)
    })

    test('a stale counter is resynced and the command replayed', async () => {
      await car.press('n')
      await call((cb) => client.unlock(cb))
    })

    test('a reboot rotates the epoch and the session recovers', async () => {
      await car.press('r')
      await call((cb) => client.lock(cb))
    })

    test('a forgotten key is turned away', async () => {
      await car.press('x')
      await assert.rejects(() => call((cb) => client.unlock(cb)), /not enrolled/)
    })
  })

  // The vehicle keypair has to survive a restart. A key caches the session key
  // it derived from that public key -- the one expensive step in the protocol,
  // and the reason the watch asks a phone to do it -- so a mock that came back
  // as a different car would force that round trip on every test run.
  describe('a car that has been switched off and on again', () => {
    const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'teslamock-')), 'car.json')
    let first = null
    let second = null

    after(async () => {
      await first?.stop()
      await second?.stop()
      fs.rmSync(path.dirname(statePath), { recursive: true, force: true })
    })

    test('keeps its identity and its whitelist', async () => {
      first = await startMockCar({ executable, vin: VIN, port: 7102, statePath, extraArgs: ['--auto-tap'] })
      const one = await first.connect()
      const clientOne = buildClient(VIN, one.link, keys)

      clientOne.requestEnrolment(ROLE.DRIVER, KEY_FORM_FACTOR.ANDROID_DEVICE)
      await new Promise((resolve) => setTimeout(resolve, 400))
      await call((cb) => clientOne.handshake(DOMAIN.VEHICLE_SECURITY, cb))
      await call((cb) => clientOne.unlock(cb))

      one.socket.destroy()
      await first.stop()
      first = null

      assert.ok(fs.existsSync(statePath), 'the car saved nothing')
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      assert.equal(saved.Keys.length, 1)

      // A brand new client with the same watch keypair: no enrolment, straight
      // to a session, which only works if the car came back as the same car.
      second = await startMockCar({ executable, vin: VIN, port: 7103, statePath })
      const two = await second.connect()
      const clientTwo = buildClient(VIN, two.link, keys)

      await call((cb) => clientTwo.handshake(DOMAIN.VEHICLE_SECURITY, cb))
      await call((cb) => clientTwo.lock(cb))
      two.socket.destroy()
    })
  })
})
