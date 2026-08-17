// The link to the companion service.
//
// Three pages used to carry their own copy of this, and they had already
// drifted: different deadlines, different handling of the case where `request`
// throws instead of rejecting, and none of them cancelling anything when the
// page went away. That last one is the dangerous default — a deadline that
// fires after onDestroy paints into freed widgets, which on Zepp OS takes the
// app down.

import { test } from 'node:test'
import assert from 'node:assert'
import crypto from 'node:crypto'

import { createPhoneChannel, createSharedSecretDeriver, REASON } from '../lib/app/phone.js'
import { toHex } from '../lib/util/hex.js'

// A controllable stand-in for ZML's page messaging.
function fakeLink () {
  const sent = []
  let settle = null

  return {
    sent,
    request (payload) {
      sent.push(payload)
      if (fakeLink.throwOnCall) throw new Error('no transport')
      return new Promise((resolve, reject) => { settle = { resolve, reject } })
    },
    answer (data) { settle.resolve(data) },
    reject () { settle.reject(new Error('link error')) }
  }
}

function channelWith (link, options) {
  const timers = []
  const channel = createPhoneChannel(Object.assign({
    request: link.request,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true }
  }, options || {}))
  return { channel, timers }
}

test('an answer settles the request and cancels its deadline', () => {
  const link = fakeLink()
  const { channel, timers } = channelWith(link)

  let got = null
  channel.ask('GET_VIN', {}, (err, data) => { got = { err, data } })
  assert.strictEqual(link.sent[0].method, 'GET_VIN')

  link.answer({ vin: '5YJ30123456789ABC' })

  return Promise.resolve().then(() => {
    assert.ok(got, 'the callback never ran')
    assert.ifError(got.err)
    assert.strictEqual(got.data.vin, '5YJ30123456789ABC')
    // Left armed, the deadline outlives the page that set it.
    assert.ok(timers[0].cleared, 'the deadline was left running after an answer')
  })
})

test('no answer at all is reported rather than waited on for good', () => {
  // With no phone in range the promise simply never settles, which is what left
  // the screen sitting on "Asking your phone…" indefinitely.
  const link = fakeLink()
  const { channel, timers } = channelWith(link)

  let got = null
  channel.ask('GET_VIN', {}, (err) => { got = err })
  assert.strictEqual(got, null, 'settled before the deadline')

  timers[0].fn()
  assert.ok(got, 'the deadline never reported')
  assert.strictEqual(got.reason, REASON.UNREACHABLE)
})

test('a deadline that fires after the answer cannot report twice', () => {
  const link = fakeLink()
  const { channel, timers } = channelWith(link)

  let calls = 0
  channel.ask('GET_VIN', {}, () => { calls++ })
  link.answer({ vin: '' })

  return Promise.resolve().then(() => {
    assert.strictEqual(calls, 1)
    timers[0].fn()
    assert.strictEqual(calls, 1, 'the deadline reported on top of a real answer')
  })
})

test('a link that was never built is a failure, not a throw', () => {
  // request() throws rather than rejecting when there is no transport at all,
  // so the call needs guarding as well as the promise.
  const { channel } = channelWith({
    request () { throw new Error('no transport') }
  })

  let got = null
  assert.doesNotThrow(() => channel.ask('GET_VIN', {}, (err) => { got = err }))
  assert.ok(got)
  assert.strictEqual(got.reason, REASON.UNREACHABLE)
})

test('nothing answers a closed channel', () => {
  // The page is gone. A late answer here would paint into widgets that no
  // longer exist, which is worse than losing the answer.
  const link = fakeLink()
  const { channel, timers } = channelWith(link)

  let calls = 0
  channel.ask('GET_VIN', {}, () => { calls++ })
  channel.close()

  link.answer({ vin: '5YJ30123456789ABC' })

  return Promise.resolve().then(() => {
    assert.strictEqual(calls, 0, 'a destroyed page was called back')
    timers[0].fn()
    assert.strictEqual(calls, 0, 'a destroyed page was called back by its deadline')
  })
})

test('a request made after close fails immediately', () => {
  const link = fakeLink()
  const { channel } = channelWith(link)
  channel.close()

  let got = null
  channel.ask('GET_VIN', {}, (err) => { got = err })
  assert.ok(got, 'a closed channel accepted a request')
  assert.strictEqual(link.sent.length, 0, 'a closed channel still spoke to the phone')
})

// --- The shared-secret deriver on top of it ---

test('a derived secret comes back as 32 bytes', () => {
  const link = fakeLink()
  const { channel } = channelWith(link)
  const derive = createSharedSecretDeriver(channel)

  const shared = new Uint8Array(crypto.randomBytes(32))
  let got = null
  derive(new Uint8Array(32).fill(3), new Uint8Array(65).fill(4), (err, bytes) => {
    got = { err, bytes }
  })

  assert.strictEqual(link.sent[0].method, 'DERIVE_SHARED_SECRET')
  assert.strictEqual(link.sent[0].privateHex.length, 64)
  assert.strictEqual(link.sent[0].vehiclePublicHex.length, 130)

  link.answer({ sharedHex: toHex(shared) })
  return Promise.resolve().then(() => {
    assert.ifError(got.err)
    assert.deepStrictEqual(got.bytes, shared)
  })
})

test('a phone that declines is told apart from a phone that is absent', () => {
  // They need different things from the owner. "Stand closer" is useless advice
  // for an off-curve vehicle key, which is a security signal and not a range
  // problem, so the two cannot share an error.
  const link = fakeLink()
  const { channel } = channelWith(link)
  const derive = createSharedSecretDeriver(channel)

  let got = null
  derive(new Uint8Array(32).fill(3), new Uint8Array(65).fill(4), (err) => { got = err })

  link.answer({ error: 'the vehicle public key is not a valid curve point' })
  return Promise.resolve().then(() => {
    assert.ok(got)
    assert.strictEqual(got.reason, REASON.REFUSED)
    assert.match(got.message, /curve point/)
  })
})

test('a short or missing secret is refused rather than used', () => {
  for (const answer of [{}, { sharedHex: '' }, { sharedHex: 'abcd' }]) {
    const link = fakeLink()
    const { channel } = channelWith(link)
    const derive = createSharedSecretDeriver(channel)

    let got = null
    derive(new Uint8Array(32).fill(3), new Uint8Array(65).fill(4), (err, bytes) => {
      got = { err, bytes }
    })
    link.answer(answer)

    Promise.resolve().then(() => {
      assert.ok(got.err, JSON.stringify(answer) + ' was accepted as a secret')
      assert.ok(!got.bytes)
    })
  }
})
