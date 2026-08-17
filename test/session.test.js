// Who owns the Bluetooth link.
//
// The answer used to be "whichever screen is in front", and it cost two faults
// at once. Tapping Controls destroyed the main screen, whose onDestroy called
// disconnect(), so the car logged the key unsubscribing about two seconds
// later. The screen that had just opened then built a second controller, called
// begin() on it, and never connected it -- so it came up reading "Tap to
// connect" over a car that had been connected a moment earlier, and every
// button on it answered "Not connected".
//
// The answer is now "the app", and these are the properties that make that
// true. They are worth holding down because the failure is silent in every
// place a developer looks: the screens render, the pages navigate, and only the
// car knows anything went wrong.

import { test } from 'node:test'
import assert from 'node:assert'
import crypto from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { createController, STATE } from '../lib/app/controller.js'
import { sharedController } from '../lib/app/session.js'
import { createSettingsStore, createMemoryBackend } from '../lib/app/settings-store.js'
import {
  VEHICLE_LOCK_STATE, TRUST, CLOSURE_FIELD, CLOSURE_STATE
} from '../lib/tesla/constants.js'
import { PROVENANCE_STRONG } from '../lib/app/identity.js'
import { createMockVehicle } from '../tools/mock-vehicle.js'
import { createFakeTransportFactory } from '../tools/fake-transport.js'
import { derivePublicKey, generatePrivateKey } from '../lib/crypto/p256.js'
import { localSharedSecret } from '../lib/tesla/session.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const VIN = '5YJ30123456789ABC'

function randomBytes (n) {
  return new Uint8Array(crypto.randomBytes(n))
}

function build () {
  const vehicle = createMockVehicle({ vin: VIN })
  const storage = createSettingsStore(createMemoryBackend())
  const privateKey = generatePrivateKey(randomBytes)
  const publicKey = derivePublicKey(privateKey)

  storage.setVin(VIN)
  storage.setKeyPair(privateKey, publicKey)
  storage.setKeyProvenance(PROVENANCE_STRONG)
  storage.setEnrolled(true)
  vehicle.enrol(publicKey)

  return {
    vehicle,
    controller: createController({
      storage,
      createTransport: createFakeTransportFactory(vehicle, {}),
      deriveSharedSecret: (priv, pub, cb) => localSharedSecret(priv, pub, cb)
    })
  }
}

function settle (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms === undefined ? 120 : ms))
}

test('one controller is shared, and begun exactly once', () => {
  const globalData = {}
  let built = 0
  let begun = 0

  const make = () => {
    built++
    const controller = build().controller
    const begin = controller.begin
    controller.begin = () => { begun++; begin.call(controller) }
    return controller
  }

  const first = sharedController(globalData, make)
  const second = sharedController(globalData, make)

  assert.strictEqual(first, second, 'the second screen got a controller of its own')
  assert.strictEqual(built, 1, 'a controller was built per screen rather than per app')
  assert.strictEqual(begun, 1, 'the state was re-derived when a second screen opened')
})

test('a second screen does not re-derive the state over a live connection', async () => {
  // begin() reads the state back from storage, which reports DISCONNECTED for
  // an enrolled key. Called again by a screen opening over a working link, it
  // would put "Tap to connect" on the display of a watch sitting at its car.
  const globalData = {}
  const controller = sharedController(globalData, () => build().controller)

  controller.connect()
  await settle()
  assert.strictEqual(controller.state, STATE.READY, 'the fixture never connected')

  sharedController(globalData, () => build().controller)
  assert.strictEqual(controller.state, STATE.READY,
    'opening a second screen reset the state of a connected car')
})

test('detaching a screen leaves the link up', async () => {
  const { controller } = build()
  // What sharedController does on the app's behalf. Without it the controller
  // holds no keys, and reaching the car only gets as far as reading them back.
  controller.begin()

  let reports = 0
  controller.attach({ onChange: () => { reports++ } })
  controller.connect()
  await settle()

  assert.strictEqual(controller.isLinked(), true, 'the fixture never connected')
  assert.ok(reports > 0, 'the attached screen was never told anything')

  const before = reports
  controller.detach()
  controller.unlock()
  await settle()

  assert.strictEqual(controller.isLinked(), true,
    'letting go of a screen took the car connection with it')
  assert.strictEqual(reports, before, 'a detached screen was still being painted')
})

test('the next screen picks up the reporting', async () => {
  const { controller } = build()
  controller.begin()
  controller.attach({ onChange: () => {} })
  controller.connect()
  await settle()
  controller.detach()

  let reports = 0
  controller.attach({ onChange: () => { reports++ } })
  controller.unlock()
  await settle()

  assert.ok(reports > 0, 'the screen that took over was never told anything')
  assert.strictEqual(controller.state, STATE.READY, 'the command failed: ' + controller.detail)
})

// The rest is source text. The behaviour above cannot catch a page that hangs
// up on the car, because the page code is bound to the Zepp OS runtime and does
// not load under Node -- which is exactly why it went unnoticed in the first
// place.
function pageSources () {
  const pages = join(root, 'page')
  return readdirSync(pages)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ name, source: readFileSync(join(pages, name), 'utf8') }))
}

// Extracts a balanced method body. Good enough for these files, where no brace
// hides in a string or a comment, and the alternative is parsing JavaScript to
// guard four lines.
function methodBody (source, name) {
  const start = source.indexOf(name + ' () {')
  if (start < 0) return ''

  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  return source.slice(start)
}

test('no screen hangs up on the car on its way out', () => {
  // Scoped to onDestroy on purpose. Dropping the link on demand is right --
  // forgetting the key from the phone does exactly that -- and what was wrong
  // was doing it because a widget tree went away.
  const offenders = pageSources()
    .filter(({ source }) => /disconnect\s*\(/.test(methodBody(source, 'onDestroy')))
    .map((page) => page.name)

  assert.deepStrictEqual(offenders, [],
    'these pages disconnect the car when they go away, which is what made ' +
    'opening Controls drop the link: ' + offenders.join(', '))
})

test('getApp is taken as the global it is, never imported', () => {
  // It is declared globally by the runtime. `@zos/app` exports getPackageInfo
  // and friends, not this, so importing it from there yields undefined and the
  // screen dies on its first line -- and nothing catches it on the way: the
  // bundler treats every @zos/* module as external and resolves no names, so
  // the build is clean and the watch is not.
  const files = pageSources().concat([
    { name: 'app.js', source: readFileSync(join(root, 'app.js'), 'utf8') }
  ])

  for (const file of files) {
    assert.doesNotMatch(file.source, /import\s*\{[^}]*\bgetApp\b[^}]*\}\s*from/,
      file.name + ' imports getApp; it is a runtime global, so that import is undefined')
  }
})

test('the app is what hangs up', () => {
  const appSource = readFileSync(join(root, 'app.js'), 'utf8')
  assert.match(appSource, /onDestroy\s*\(\)\s*\{[\s\S]*disconnect\s*\(/,
    'nothing closes the link when the app closes')
})

test('every screen that drives the car takes the shared controller', () => {
  const drivers = pageSources().filter(({ source }) => /createController\s*\(/.test(source))
  assert.ok(drivers.length > 0, 'no page builds a controller any more')

  for (const page of drivers) {
    assert.match(page.source, /sharedController\s*\(/,
      page.name + ' builds a controller of its own rather than sharing the app’s')
  }
})

test('the car is asked what it is as soon as there is a link', async () => {
  // The display for this has been there a while; nothing ever filled it in.
  // Status arrived only in reply to a command, so the line sat blank from the
  // moment the watch connected until somebody pressed something -- which is
  // backwards, since "are the doors locked" is the question you have on the way
  // to the car, not after you have already acted.
  const { controller, vehicle } = build()
  controller.begin()
  controller.connect()
  await settle(700)

  assert.strictEqual(controller.state, STATE.READY, 'never connected: ' + controller.detail)
  assert.ok(controller.vehicleStatus,
    'the car was never asked, so the screen has nothing to report')
  assert.strictEqual(controller.statusTrust, TRUST.VERIFIED,
    'the reading was overheard rather than asked for')
  assert.strictEqual(controller.vehicleStatus.lockState, VEHICLE_LOCK_STATE.LOCKED)

  // And it is a read, not a command: nothing was actuated to find out.
  assert.strictEqual(vehicle.events.filter((e) => e.type === 'rke').length, 0,
    'asking the car what it is actuated something')
})

test('a pending read does not outlive the link it was scheduled on', async () => {
  const { controller } = build()
  controller.begin()
  controller.connect()
  // Dropped inside the window between the link coming up and the read firing,
  // which is the whole point: the read is deferred off the Bluetooth callback,
  // so there is a window in which it is owed to a connection already gone.
  await settle(80)
  controller.disconnect()
  await settle(700)

  assert.strictEqual(controller.vehicleStatus, null,
    'a read fired over a link that had already been closed')
})

test('a panel still moving is asked about again until it settles', async () => {
  // The car answers the read that follows a command with "opening", because at
  // that instant it is. Nothing asked again, so the boot finished opening and
  // the screen went on saying "opening" for as long as the app stayed open.
  const { controller, vehicle } = build()
  controller.begin()
  controller.connect()
  await settle(500)

  vehicle.setClosureState(CLOSURE_FIELD.REAR_TRUNK, CLOSURE_STATE.OPENING)
  controller.openTrunk()
  await settle(500)

  assert.strictEqual(controller.closureState(CLOSURE_FIELD.REAR_TRUNK), CLOSURE_STATE.OPENING,
    'the fixture never reported a moving panel')

  // The panel arrives while the follow-up reads are still running.
  vehicle.setClosureState(CLOSURE_FIELD.REAR_TRUNK, CLOSURE_STATE.OPEN)
  await settle(2200)

  assert.strictEqual(controller.closureState(CLOSURE_FIELD.REAR_TRUNK), CLOSURE_STATE.OPEN,
    'the screen is still reporting a panel that stopped moving')
})

test('a panel that never arrives stops being asked about', async () => {
  // An obstruction, or a boot nobody can shut remotely. The follow-up reads
  // have to end, or they are a poll that runs until the app closes.
  const { controller, vehicle } = build()
  controller.begin()
  controller.connect()
  await settle(500)

  vehicle.setClosureState(CLOSURE_FIELD.REAR_TRUNK, CLOSURE_STATE.CLOSING)
  controller.closeTrunk()
  await settle(1000)

  const before = vehicle.events.length
  await settle(11000)
  const added = vehicle.events.length - before

  assert.ok(added <= 7, 'still polling a stuck panel after ten seconds: ' + added + ' reads')
  assert.strictEqual(controller.closureState(CLOSURE_FIELD.REAR_TRUNK), CLOSURE_STATE.CLOSING,
    'the last thing the car said should stand')
})
