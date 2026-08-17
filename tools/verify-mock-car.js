// Drives the real watch client against the C# mock car, over a socket.
//
//   node tools/verify-mock-car.js
//
// tools/mock-vehicle.js already checks the protocol against a second
// implementation, but both sides of that conversation are JavaScript in one
// process. This runs the same client against a different language, a different
// crypto library and a different process, with the bytes going over a real
// socket in 20-byte fragments -- so anything the two implementations happen to
// agree on by construction shows up here as a mismatch.
//
// Everything a car does that needs a person present -- the keycard tap, a
// reboot, leaving a door open -- is driven by writing single letters to the
// mock's stdin, which is the same thing its keyboard shortcuts do.

import crypto from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { createClient } from '../lib/tesla/client.js'
import { localSharedSecret } from '../lib/tesla/session.js'
import { generatePrivateKey, derivePublicKey } from '../lib/crypto/p256.js'
import { frameMessage, createReassembler } from '../lib/tesla/framing.js'
import { vehicleLocalName, parseVehicleStatus, closureStateName, lockStateName } from '../lib/tesla/messages.js'
import { localNameOverride } from '../lib/app/device-name.js'
import { DOMAIN, ROLE, KEY_FORM_FACTOR, CLOSURE_FIELD, CLOSURE_STATE, VEHICLE_LOCK_STATE } from '../lib/tesla/constants.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const VIN = process.argv[2] || '5YJ30123456789ABC'
const PORT = 7099
const CHUNK = 20

let failures = 0
let lastStatus = null

function heading (text) {
  console.log('\n\x1b[1m' + text + '\x1b[0m')
  console.log('─'.repeat(Math.max(text.length, 60)))
}

function ok (text) {
  console.log('  \x1b[32m✓\x1b[0m ' + text)
}

function bad (text) {
  failures++
  console.log('  \x1b[31m✗\x1b[0m ' + text)
}

function step (text) {
  console.log('  ' + text)
}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function call (fn) {
  return new Promise((resolve) => {
    fn((err, result) => resolve({ err, result }))
  })
}

async function expectOk (label, fn) {
  const { err } = await call(fn)
  if (err) bad(label + ': ' + err.message)
  else ok(label)
  return !err
}

async function expectFailure (label, fn, match) {
  const { err } = await call(fn)
  if (!err) bad(label + ': it succeeded, and should not have')
  else if (match && !err.message.toLowerCase().includes(match)) bad(label + ': failed with the wrong reason: ' + err.message)
  else ok(label + ': ' + err.message)
}

function findExecutable () {
  const base = path.join(root, 'mock-car', 'bin')
  if (!fs.existsSync(base)) return null

  const found = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'teslamock.exe' || entry.name === 'teslamock') found.push(full)
    }
  }
  walk(base)
  if (found.length === 0) return null

  // Prefer whichever build is newest, so a fresh Release build wins over a
  // stale Debug one.
  found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return found[0]
}

function startMockCar (executable) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [
      '--vin', VIN,
      '--no-ble',
      '--tcp', String(PORT),
      '--no-state',
      '--motion-ms', '0',
      '--quiet'
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error('the mock car did not start listening within 15 seconds'))
    }, 15000)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (text) => {
      if (process.env.MOCK_CAR_LOG) process.stdout.write('\x1b[2m' + text + '\x1b[0m')
      if (!settled && text.includes('listening on 127.0.0.1:' + PORT)) {
        settled = true
        clearTimeout(timer)
        resolve(child)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text) => process.stderr.write(text))
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('the mock car exited with code ' + code))
    })
  })
}

// The same link shape the watch's BLE transport presents to the client, with
// the same 20-byte fragmentation a GATT link imposes.
function connectLink () {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: PORT }, () => {
      const reassembler = createReassembler()
      let handler = null

      socket.on('data', (chunk) => {
        let messages
        try {
          messages = reassembler.push(new Uint8Array(chunk))
        } catch (e) {
          bad('framing error from the car: ' + e.message)
          reassembler.reset()
          return
        }
        for (const message of messages) if (handler) handler(message)
      })

      resolve({
        socket,
        link: {
          send (message) {
            for (const fragment of frameMessage(message, CHUNK)) socket.write(Buffer.from(fragment))
          },
          onMessage (callback) {
            handler = callback
          }
        }
      })
    })
    socket.on('error', reject)
  })
}

async function run () {
  heading('Freesla: the watch client against the C# mock car')
  step('VIN                  ' + VIN)
  step('Advertised BLE name  ' + vehicleLocalName(VIN))
  // This run is over a socket, where the name decides nothing -- but a build
  // left with an override is worth mentioning wherever it is noticed, because
  // on the watch it is silent.
  const override = localNameOverride()
  if (override) {
    step('Watch build scans for ' + override + '  (BLE_NAME_OVERRIDE in freesla.config.js)')
  }

  const executable = findExecutable()
  if (!executable) {
    console.log('\n  The mock car has not been built. Run:\n')
    console.log('      dotnet build mock-car\n')
    process.exitCode = 1
    return
  }
  step('Mock car             ' + path.relative(root, executable))

  const car = await startMockCar(executable)
  const press = (key) => new Promise((resolve) => {
    car.stdin.write(key + '\n')
    setTimeout(resolve, 250)
  })

  try {
    const { socket, link } = await connectLink()

    const privateKey = generatePrivateKey((n) => new Uint8Array(crypto.randomBytes(n)))
    const publicKey = derivePublicKey(privateKey)

    const client = createClient({
      vin: VIN,
      privateKey,
      publicKey,
      link,
      randomBytes: (n) => new Uint8Array(crypto.randomBytes(n)),
      deriveSharedSecret: localSharedSecret,
      onStatus (status, trust) {
        lastStatus = { status, trust }
      }
    })

    heading('1. A key the car does not know')
    await expectFailure('handshake refused before enrolment',
      (cb) => client.handshake(DOMAIN.VEHICLE_SECURITY, cb), 'not enrolled')

    heading('2. Enrolment')
    client.requestEnrolment(ROLE.DRIVER, KEY_FORM_FACTOR.ANDROID_DEVICE)
    await delay(300)
    step('The car is now waiting for a keycard tap; nothing the watch sends can substitute.')
    await press('k')
    ok('keycard tapped')

    heading('3. Handshake')
    client.reset()
    await expectOk('session established', (cb) => client.handshake(DOMAIN.VEHICLE_SECURITY, cb))

    heading('4. Commands')
    await expectOk('unlock', (cb) => client.unlock(cb))
    await expectOk('lock', (cb) => client.lock(cb))
    await expectOk('trunk open', (cb) => client.openTrunk(cb))
    await expectOk('frunk open', (cb) => client.openFrunk(cb))
    await expectOk('charge port', (cb) => client.openChargePort(cb))
    await expectOk('all four doors, one message each', (cb) => client.openDoors(cb))

    heading('5. Reading the car back')
    lastStatus = null
    await expectOk('status requested', (cb) => client.requestVehicleStatus(cb))
    if (!lastStatus) {
      bad('the car sent no VehicleStatus')
    } else {
      const { status, trust } = lastStatus
      ok('status arrived, trust: ' + trust)
      step('lock state   ' + lockStateName(status.lockState))
      for (const field of Object.keys(status.closures)) {
        step('  ' + String(CLOSURE_FIELD.REAR_TRUNK === Number(field) ? 'trunk' : 'closure ' + field).padEnd(12) +
          closureStateName(status.closures[field]))
      }
      if (status.closures[CLOSURE_FIELD.REAR_TRUNK] === CLOSURE_STATE.OPEN) ok('the trunk really did open')
      else bad('the trunk reports ' + closureStateName(status.closures[CLOSURE_FIELD.REAR_TRUNK]))
      if (status.lockState === VEHICLE_LOCK_STATE.UNLOCKED) ok('opening a door unlocked the car, as it should')
      else bad('lock state is ' + lockStateName(status.lockState))
      if (trust !== 'verified') bad('an encrypted reply should be verified, not ' + trust)
    }

    heading('6. A car that refuses')
    await expectFailure('lock refused while something is open',
      (cb) => client.lock(cb), 'still open')
    await press('c')
    ok('everything shut')
    await expectOk('lock accepted once shut', (cb) => client.lock(cb))

    heading('7. Recovery')
    await press('n')
    step('The next command will be rejected as a repeated counter…')
    await expectOk('resynced and replayed after the counter fault', (cb) => client.unlock(cb))

    await press('r')
    step('The car rebooted, rotating its epoch and voiding the session…')
    await expectOk('resynced and replayed after the epoch change', (cb) => client.lock(cb))

    heading('8. A key the car has forgotten')
    await press('x')
    await expectFailure('command rejected once the key is off the whitelist',
      (cb) => client.unlock(cb), 'not enrolled')

    socket.destroy()
  } finally {
    car.stdin.write('q\n')
    await delay(300)
    car.kill()
  }

  heading('Summary')
  if (failures === 0) {
    ok('The watch client and a C# vehicle agree, byte for byte, over a real socket.')
    console.log('')
  } else {
    bad(failures + ' check' + (failures === 1 ? '' : 's') + ' failed')
    console.log('')
    process.exitCode = 1
  }
}

run().catch((err) => {
  bad(err.message)
  console.error(err)
  process.exitCode = 1
})
