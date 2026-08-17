// The phone-to-watch link.
//
// The companion service carries the VIN, and nothing else in the app can do it:
// settings storage lives on the phone and the watch cannot read it. When this
// path fails the watch sits on "no VIN entered" forever, with the VIN plainly
// visible in the phone's settings screen -- no error, nothing to retry, and no
// indication of which side is at fault.

import { test } from 'node:test'
import assert from 'node:assert'

import crypto from 'node:crypto'

import { startSideService, storedVin } from './helpers/side-service-env.js'
import { derivePublicKey, generatePrivateKey, isValidPrivateKey } from '../lib/crypto/p256.js'
import { fromHex, toHex } from '../lib/util/hex.js'

const VIN = '5YJ30123456789ABC'

function vinCalls (env) {
  return env.calls.filter((c) => c.method === 'SET_VIN')
}

test('a VIN typed while the service is running reaches the watch', async () => {
  const env = await startSideService()
  try {
    env.changeSetting('vin', storedVin(VIN))

    assert.strictEqual(vinCalls(env).length, 1, 'the watch was never told')
    assert.strictEqual(vinCalls(env)[0].vin, VIN)
  } finally {
    env.restore()
  }
})

test('a VIN typed while the service is stopped still reaches the watch', async () => {
  // The case that actually happens. The service is not running -- it rarely is
  // -- so the settings edit is what starts it, and the change it was started
  // for has already been and gone by the time any of the service's own code
  // runs. A plain change listener registered at startup never sees it, and the
  // VIN silently never leaves the phone.
  const env = await startSideService({
    launchedBySettingsChange: true,
    launchArgs: { key: 'vin', newValue: storedVin(VIN) },
    settings: { vin: storedVin(VIN) }
  })
  try {
    assert.strictEqual(vinCalls(env).length, 1,
      'the settings change that started the service was dropped')
    assert.strictEqual(vinCalls(env)[0].vin, VIN)
  } finally {
    env.restore()
  }
})

test('a half-typed VIN is not forwarded', async () => {
  const env = await startSideService()
  try {
    // The settings screen writes on every keystroke, so most values it stores
    // are incomplete. Forwarding one would leave the watch scanning for a car
    // whose name it cannot derive.
    for (const partial of ['5', '5YJ301', '5YJ30123456789A']) {
      env.changeSetting('vin', storedVin(partial))
    }
    assert.strictEqual(vinCalls(env).length, 0, 'an incomplete VIN was sent')

    env.changeSetting('vin', storedVin(VIN))
    assert.strictEqual(vinCalls(env).length, 1)
  } finally {
    env.restore()
  }
})

test('a VIN with an impossible character is not forwarded', async () => {
  const env = await startSideService()
  try {
    // 17 characters, but contains O and I -- always a misread 0 and 1, so this
    // is a typo rather than a car.
    env.changeSetting('vin', storedVin('5YJ3O123456789ABI'))
    assert.strictEqual(vinCalls(env).length, 0, 'a misread VIN was sent')
  } finally {
    env.restore()
  }
})

test('the watch can pull a VIN that was entered before it ever opened', async () => {
  // The other half of the story: a push only lands if the watch app happens to
  // be open, which it usually is not while someone is typing on their phone.
  const env = await startSideService({ settings: { vin: storedVin(VIN) } })
  try {
    const answer = await env.request({ method: 'GET_VIN' })
    assert.strictEqual(answer.vin, VIN)
  } finally {
    env.restore()
  }
})

test('the watch is told plainly when no complete VIN is stored', async () => {
  const env = await startSideService({ settings: { vin: storedVin('5YJ301') } })
  try {
    const answer = await env.request({ method: 'GET_VIN' })
    // Not the partial string: "still being typed" must not look to the watch
    // like an answer it can act on.
    assert.strictEqual(answer.vin, '')
  } finally {
    env.restore()
  }
})

test('a service woken for some other reason forwards nothing', async () => {
  // Started by a file transfer, a message, anything. There are no launch
  // arguments to replay, and inventing a change from stale storage would push
  // a VIN the owner never touched.
  const env = await startSideService({ launchedBySettingsChange: false, settings: { vin: storedVin(VIN) } })
  try {
    assert.strictEqual(env.calls.length, 0, 'something was pushed unprompted')
  } finally {
    env.restore()
  }
})

test('forgetting the key and the auto-unlock toggle reach the watch', async () => {
  const env = await startSideService()
  try {
    env.changeSetting('forgetKey', JSON.stringify(1))
    env.changeSetting('autoUnlock', 'true')

    assert.ok(env.calls.some((c) => c.method === 'FORGET_KEY'), 'key reset not forwarded')
    const toggle = env.calls.find((c) => c.method === 'SET_AUTO_UNLOCK')
    assert.ok(toggle, 'auto-unlock not forwarded')
    assert.strictEqual(toggle.enabled, true)
  } finally {
    env.restore()
  }
})

test('the phone reports its randomness capability without being asked', async () => {
  // The settings screen cannot work this out for itself, and until this lands
  // it shows "not checked yet" -- which reads as a fault rather than as a
  // service that has simply never run.
  const env = await startSideService()
  try {
    const source = JSON.parse(env.storage.getItem('entropySource'))
    assert.ok(source && source !== 'none', 'no usable randomness reported: ' + source)
    assert.ok(env.storage.getItem('entropyCheckedAt'), 'no timestamp recorded')
  } finally {
    env.restore()
  }
})

test('the entropy probe answers a re-check from the settings screen', async () => {
  const env = await startSideService()
  try {
    env.storage.setItem('entropyCheckedAt', JSON.stringify(0))
    env.changeSetting('entropyProbeRequest', JSON.stringify(1))

    assert.notStrictEqual(JSON.parse(env.storage.getItem('entropyCheckedAt')), 0,
      'the re-check was ignored')
  } finally {
    env.restore()
  }
})

test('the phone builds the watch a keypair, quickly', async () => {
  // The whole point of moving this here: the same curve code that needs about
  // ninety seconds on the watch's interpreter runs in milliseconds on a phone.
  const env = await startSideService()
  try {
    const started = Date.now()
    const answer = await env.request({ method: 'GET_KEYPAIR' })
    const elapsed = Date.now() - started

    assert.strictEqual(answer.quality, 'strong')
    assert.strictEqual(answer.privateHex.length, 64, 'private key is not 32 bytes')
    assert.strictEqual(answer.publicHex.length, 130, 'public key is not 65 uncompressed bytes')
    assert.ok(answer.publicHex.startsWith('04'), 'public key is not an uncompressed point')
    assert.ok(elapsed < 5000, 'took ' + elapsed + 'ms -- no better than the watch')
  } finally {
    env.restore()
  }
})

test('the keypair the phone sends actually belongs together', async () => {
  const env = await startSideService()
  try {
    const answer = await env.request({ method: 'GET_KEYPAIR' })
    const privateKey = fromHex(answer.privateHex)
    const publicKey = fromHex(answer.publicHex)

    // The watch cannot afford this check -- deriving is the ninety seconds it
    // is avoiding -- so it is made here instead, where it costs nothing.
    assert.deepStrictEqual(derivePublicKey(privateKey), publicKey,
      'the phone sent a private key and a public key that do not match')
    assert.ok(isValidPrivateKey(privateKey), 'private key out of range')
  } finally {
    env.restore()
  }
})

test('two keypairs are never the same', async () => {
  const env = await startSideService()
  try {
    const a = await env.request({ method: 'GET_KEYPAIR' })
    const b = await env.request({ method: 'GET_KEYPAIR' })
    assert.notStrictEqual(a.privateHex, b.privateHex, 'the generator repeats itself')
  } finally {
    env.restore()
  }
})

test('raw entropy is no longer handed out for the watch to make a key from', async () => {
  // GET_ENTROPY existed so the watch could build its own key from phone
  // randomness. Both halves of that are gone: the watch cannot afford the
  // ninety seconds of curve maths, and answering this again would invite a
  // caller to try. An unknown method falls through to the empty reply.
  const env = await startSideService()
  try {
    const answer = await env.request({ method: 'GET_ENTROPY', bytes: 48 })
    assert.ok(!answer.hex, 'the phone still supplies key-grade entropy to the watch')
  } finally {
    env.restore()
  }
})

// --- The elliptic-curve work the watch cannot do ---
//
// Both of these are one-time per car. The watch caches what comes back and
// never asks again, which is what lets it open a familiar car with no phone
// anywhere near it.

function randomBytes (n) {
  return new Uint8Array(crypto.randomBytes(n))
}

test('the phone derives the ECDH shared secret the watch cannot', async () => {
  // ~14ms here. The same sum is ~87 seconds on the watch's interpreter, and it
  // would run inside a native Bluetooth callback, which resets the device.
  const env = await startSideService()
  try {
    const privateKey = generatePrivateKey(randomBytes)
    const publicKey = derivePublicKey(privateKey)

    const car = crypto.createECDH('prime256v1')
    car.generateKeys()

    const data = await env.request({
      method: 'DERIVE_SHARED_SECRET',
      privateHex: toHex(privateKey),
      vehiclePublicHex: toHex(new Uint8Array(car.getPublicKey()))
    })

    assert.ok(data.sharedHex, 'no secret came back: ' + JSON.stringify(data))
    // Checked against the far side rather than against ourselves. A shared
    // secret that only agrees with our own implementation is worth nothing --
    // it has to be the number the car independently arrives at.
    assert.strictEqual(data.sharedHex,
      car.computeSecret(Buffer.from(publicKey)).toString('hex'),
      'the phone and the car disagree about the shared secret')
  } finally {
    env.restore()
  }
})

test('the phone refuses to derive against a point that is not on the curve', async () => {
  // The check that stops an invalid-curve attack from walking the private key
  // out one bit at a time. Refusing here is the whole reason this goes through
  // ecdh() rather than a raw scalar multiplication.
  const env = await startSideService()
  try {
    const car = crypto.createECDH('prime256v1')
    car.generateKeys()
    const bent = new Uint8Array(car.getPublicKey())
    bent[40] ^= 0xff

    const data = await env.request({
      method: 'DERIVE_SHARED_SECRET',
      privateHex: toHex(generatePrivateKey(randomBytes)),
      vehiclePublicHex: toHex(bent)
    })

    assert.ok(!data.sharedHex, 'an off-curve point produced a secret')
    assert.match(data.error, /curve point/)
  } finally {
    env.restore()
  }
})

test('the phone refuses a malformed request rather than guessing', async () => {
  const env = await startSideService()
  try {
    const car = crypto.createECDH('prime256v1')
    car.generateKeys()
    const goodVehicle = toHex(new Uint8Array(car.getPublicKey()))
    const goodPrivate = toHex(generatePrivateKey(randomBytes))

    for (const [what, payload] of [
      ['no private key', { vehiclePublicHex: goodVehicle }],
      ['a zero private key', { privateHex: toHex(new Uint8Array(32)), vehiclePublicHex: goodVehicle }],
      ['a short private key', { privateHex: 'abcd', vehiclePublicHex: goodVehicle }],
      ['no vehicle key', { privateHex: goodPrivate }],
      ['a truncated vehicle key', { privateHex: goodPrivate, vehiclePublicHex: goodVehicle.slice(0, 40) }],
      ['nothing at all', {}]
    ]) {
      const data = await env.request({ method: 'DERIVE_SHARED_SECRET', ...payload })
      assert.ok(!data.sharedHex, what + ' produced a secret')
      assert.ok(data.error, what + ' was refused without saying why')
    }
  } finally {
    env.restore()
  }
})
