// The Bluetooth conversation, against a fake radio.
//
// This layer had no coverage whatsoever, and it is the layer that was taking
// the whole watch down. The faults were not subtle once looked for: every
// fragment of a message was pushed at the controller in one synchronous loop
// with nothing waiting for it to drain, a connection was opened from inside the
// scan callback while the scan was still unwinding, and teardown freed the GATT
// profile before closing the connection that was using it. Each is a documented
// way to crash a BLE stack, and none of them can be reproduced in a simulator
// that has no radio.
//
// The fake radio complains about exactly those things, so they cannot come back.

import { test } from 'node:test'
import assert from 'node:assert'

import { createBleSession } from '../lib/zepp/ble-session.js'
import { STATE } from '../lib/zepp/ble-states.js'
import { createFakeRadio } from './helpers/fake-radio.js'

const SERVICE = '00000211-b2d1-43f0-9b88-960cebf8b91e'
const WRITE = '00000212-b2d1-43f0-9b88-960cebf8b91e'
const NOTIFY = '00000213-b2d1-43f0-9b88-960cebf8b91e'
const CAR = 'S1a2b3c4d5e6f7g8h'

function settle (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms === undefined ? 250 : ms))
}

function open (radio, options) {
  const states = []
  const session = createBleSession(radio, Object.assign({
    serviceUuid: SERVICE,
    writeUuid: WRITE,
    notifyUuid: NOTIFY,
    // The three stack calls that declare, resolve and discover the profile are
    // deliberately spaced on hardware; a test has no stack to give a breath to,
    // and paying it here would add a quarter of a second to every case.
    profileSettleMs: 1,
    onState: (state, detail) => states.push({ state, detail })
  }, options || {}))
  return { session, states }
}

// Walks a session all the way to READY, and past the point where it is
// actually usable.
//
// READY is announced as soon as the CCCD write goes out, but that write holds
// the queue's one-in-flight slot until it settles -- deliberately, so the first
// fragment does not overlap it. A caller that sends the instant READY arrives
// is queued rather than written, which is correct behaviour and not what most
// of these tests are trying to exercise.
async function connected (radio, options) {
  const ctx = open(radio, options)
  ctx.session.connect(CAR)
  radio.advertise(CAR)
  await settle()
  radio.completeConnection()
  await settle()
  radio.completePrepare()
  await settle()
  return ctx
}

test('it reaches a usable link through the full handshake', async () => {
  const radio = createFakeRadio()
  const { session } = await connected(radio)

  assert.strictEqual(session.state, STATE.READY)
  assert.ok(!radio.crashed, 'the stack was misused: ' + radio.faults.join('; '))
  // Notifications are only useful once the CCCD says so.
  assert.ok(radio.types().includes('writeDescriptor'), 'notifications were never enabled')
})

test('every stack call it makes is announced before it is made', async () => {
  // The reason this is worth asserting rather than trusting: a watchdog reset
  // destroys the screen, the log and the app's memory at once, so the last
  // step reported is the only surviving evidence of where it happened. If two
  // stack calls share one caption, that evidence cannot tell them apart, and
  // "Connecting" once covered the scan, the connection, three separate calls
  // to declare and discover the profile, and the descriptor write.
  const radio = createFakeRadio()
  const { states } = await connected(radio)

  const said = states.map((s) => s.detail).filter(Boolean)
  const together = said.join(' | ')

  for (const expected of [
    /looking for/i,
    /found it at/i,
    /opening the link/i,
    /link open/i,
    /asking the car for its profile/i,
    /notifications/i
  ]) {
    assert.ok(expected.test(together),
      'no step matched ' + expected + ', so a reset there would be unattributable: ' + together)
  }

  // Distinct, not merely present: two steps sharing a caption are one step as
  // far as anybody reading the evidence is concerned.
  const seen = {}
  for (const detail of said) {
    assert.ok(!seen[detail], 'the caption "' + detail + '" is used for more than one step')
    seen[detail] = true
  }
})

test('discovery is started once, by mstBuildProfile, and never twice', async () => {
  // The fault that reset the watch. mstBuildProfile is not a declaration to be
  // followed by a separate discovery -- it *is* the discovery, and the profile
  // pointer arrives through mstOnPrepare because nothing else produces one.
  // Calling mstPrepare after it started a second discovery on a profile whose
  // first was still running, which is why the fake faults on both calls.
  const radio = createFakeRadio()
  const { session } = await connected(radio)

  assert.strictEqual(session.state, STATE.READY)
  assert.ok(radio.types().includes('buildProfile'), 'the profile was never asked for')
  assert.ok(!radio.types().includes('prepare'),
    'mstPrepare was called; it is not part of this flow and re-enters discovery')
  assert.ok(!radio.types().includes('getProfile'),
    'mstGetProfileInstance was called; the pointer comes from the prepare callback')
  assert.ok(!radio.crashed, radio.faults.join('; '))
})

test('the profile it talks to is the one the callback handed back', async () => {
  // There is no other source. mstBuildProfile answers a boolean, so a session
  // that did not take the pointer from mstOnPrepare would be addressing the
  // link by whatever it had -- null, on this path.
  const radio = createFakeRadio()
  const { session } = await connected(radio)

  session.send(new Uint8Array([1, 2, 3]))
  await settle()

  const write = radio.events.find((e) => e.type === 'write')
  assert.ok(write, 'nothing was written')
  assert.strictEqual(write.profile, 7, 'wrote against a profile the stack never issued')
})

test('the profile is asked for only once the prepare callback is registered', async () => {
  const radio = createFakeRadio()
  const { session } = open(radio, { prepareDelayMs: 60 })

  session.connect(CAR)
  radio.advertise(CAR)
  await settle()
  radio.completeConnection()

  // Straight after the connection: the delay has not elapsed, so nothing has
  // been asked for yet -- registering the callback first is what makes it fire
  // at all.
  assert.ok(!radio.types().includes('buildProfile'),
    'the profile was asked for from inside the connect callback')

  await settle(120)
  assert.ok(radio.types().includes('buildProfile'), 'the profile was never asked for')
  assert.ok(!radio.crashed, radio.faults.join('; '))
})

test('discovery that never comes back is given up on rather than waited on forever', async () => {
  // The failure this leaves behind when the stack does not crash but does not
  // answer either: the screen sat on "finding the profile" with nothing left
  // to move it, and the connection still open behind it.
  const radio = createFakeRadio()
  const { session, states } = open(radio, { prepareTimeoutMs: 60 })

  session.connect(CAR)
  radio.advertise(CAR)
  await settle()
  radio.completeConnection()
  // Deliberately never completePrepare().
  await settle(400)

  assert.strictEqual(session.state, STATE.FAILED)
  const last = states[states.length - 1]
  assert.ok(/stopped responding/i.test(last.detail), 'unhelpful failure: ' + last.detail)
})

test('a prepare that does come back does not fail later on its own deadline', async () => {
  // The other half: a deadline nobody cancels reports a failure over a
  // connection that is working.
  const radio = createFakeRadio()
  const { session } = await connected(radio, { prepareTimeoutMs: 60 })

  assert.strictEqual(session.state, STATE.READY)
  await settle(200)
  assert.strictEqual(session.state, STATE.READY, 'the prepare deadline fired after preparation succeeded')
})

test('the steps carry how far into the attempt they happened', async () => {
  const radio = createFakeRadio()
  const lines = []
  const ctx = open(radio, { log: (text) => lines.push(text) })

  ctx.session.connect(CAR)
  radio.advertise(CAR)
  await settle()

  // Every line timed from the start of the attempt, so a gap in the log is
  // measurable without reaching for wall-clock timestamps that may not be
  // recorded at all.
  const timed = lines.filter((line) => /^\+\d+ms/.test(line))
  assert.ok(timed.length >= 3, 'the log carries no elapsed figures: ' + lines.join(' | '))
})

test('message fragments go out one at a time, never in a burst', async () => {
  // The crash. A handshake is a few hundred bytes, which at a 20-byte MTU is a
  // dozen-odd fragments; sent back to back with no flow control they overrun
  // the controller's transmit queue.
  const radio = createFakeRadio()
  const { session } = await connected(radio)

  const big = new Uint8Array(200)
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff
  session.send(big)

  assert.strictEqual(radio.writes().length, 1, 'more than one fragment was pushed at once')
  assert.ok(!radio.crashed, radio.faults.join('; '))

  // And the rest follow only as the controller reports each one done.
  let guard = 0
  while (radio.writesOutstanding > 0 && guard < 100) {
    const before = radio.writes().length
    radio.completeWrite()
    assert.ok(radio.writes().length <= before + 1, 'more than one fragment released at a time')
    guard++
  }

  assert.ok(radio.writes().length > 1, 'the message never finished sending')
  assert.ok(!radio.crashed, radio.faults.join('; '))
})

test('a stalled controller does not wedge the queue for good', async () => {
  // If the completion callback never arrives, the fallback timer has to move
  // things along or the car never hears another word from us.
  const radio = createFakeRadio()
  const { session } = await connected(radio)

  session.send(new Uint8Array(60))
  const first = radio.writes().length
  assert.strictEqual(first, 1)

  // Never call completeWrite; wait past the fallback.
  await settle(600)
  assert.ok(radio.writes().length > first, 'the queue stalled with no way out')
})

test('the connection is not opened from inside the scan callback', async () => {
  // Connecting while the stack is still tearing the scan down is the other
  // half of the same class of fault.
  const radio = createFakeRadio()
  const { session } = open(radio)

  session.connect(CAR)
  radio.advertise(CAR)

  // Straight after the advertisement: the scan is stopped but no connect yet.
  assert.ok(radio.types().includes('stopScan'), 'the scan was left running')
  assert.ok(!radio.types().includes('connect'), 'connected before the scan had settled')

  await settle()
  assert.ok(radio.types().includes('connect'), 'the connection was never opened')
  assert.ok(!radio.crashed, radio.faults.join('; '))
})

test('a scan that finds nothing gives up and says so', async () => {
  // It used to sweep forever: nothing stopped it, and the screen had no way
  // out of "looking for your car".
  const radio = createFakeRadio()
  const { session, states } = open(radio, { scanTimeoutMs: 40 })

  session.connect(CAR)
  assert.ok(radio.isScanning)

  await settle(400)

  assert.ok(!radio.isScanning, 'the radio was left scanning')
  assert.strictEqual(session.state, STATE.FAILED)
  const last = states[states.length - 1]
  assert.ok(/not found/i.test(last.detail), 'unhelpful failure: ' + last.detail)
})

test('a fruitless scan logs the names it did see', async () => {
  // The name must match exactly, so every near miss -- a mock car advertising
  // under its machine's name, a VIN entered with one character wrong -- ends
  // here looking identical to a car that is out of range. What was in the air
  // is the one piece of evidence that tells those apart.
  const radio = createFakeRadio()
  const lines = []
  const { session } = open(radio, { scanTimeoutMs: 40, log: (text) => lines.push(text) })

  session.connect(CAR)
  radio.advertise('IDCT-FLOW13')
  radio.advertise('Some Headphones')
  radio.advertise('IDCT-FLOW13')

  await settle(400)

  assert.strictEqual(session.state, STATE.FAILED)
  const said = lines.join('\n')
  assert.ok(said.indexOf('IDCT-FLOW13') >= 0, 'never mentioned what was advertising: ' + said)
  assert.ok(said.indexOf('Some Headphones') >= 0, 'only reported the first name seen')
  assert.strictEqual(said.split('IDCT-FLOW13').length - 1, 1, 'repeated the same name twice')
})

test('a fruitless scan with nothing in the air says that instead', async () => {
  const radio = createFakeRadio()
  const lines = []
  const { session } = open(radio, { scanTimeoutMs: 40, log: (text) => lines.push(text) })

  session.connect(CAR)
  await settle(400)

  assert.ok(lines.join('\n').indexOf('no other named advertisement reached the scan') >= 0,
    'a silent radio and a radio full of other cars read the same in the log')
})

test('teardown closes the link before freeing the profile', async () => {
  const radio = createFakeRadio()
  const { session } = await connected(radio)
  await settle(10)

  session.close()

  const order = radio.types()
  const disconnectAt = order.lastIndexOf('disconnect')
  const destroyAt = order.lastIndexOf('destroyProfile')
  assert.ok(disconnectAt >= 0, 'never disconnected')
  assert.ok(destroyAt >= 0, 'never freed the profile')
  assert.ok(disconnectAt < destroyAt,
    'the profile was freed while the connection was still open')
  assert.ok(!radio.crashed, radio.faults.join('; '))
})

test('a malformed notification costs one message, not the watch', async () => {
  // This runs on a native callback. A throw crossing back into the Bluetooth
  // stack is not something the runtime walks away from, so nothing here may
  // escape -- including a length that points past the end of the buffer.
  const radio = createFakeRadio()
  const { session } = await connected(radio)

  const rubbish = [
    undefined,
    {},
    { uuid: NOTIFY },
    { uuid: NOTIFY, data: null, length: 4 },
    { uuid: NOTIFY, data: new Uint8Array(4).buffer, length: 4000 },
    { uuid: NOTIFY, data: new Uint8Array(0).buffer, length: 0 },
    { uuid: 'not-ours', data: new Uint8Array(4).buffer, length: 4 }
  ]

  for (const event of rubbish) {
    assert.doesNotThrow(() => radio.notify(event), 'threw on: ' + JSON.stringify(event))
  }
  assert.strictEqual(session.state, STATE.READY, 'the link fell over')
})

test('a dropped connection is reported as the car going out of range', async () => {
  const radio = createFakeRadio()
  const { session, states } = await connected(radio)
  await settle(10)

  radio.dropConnection()

  assert.strictEqual(session.state, STATE.IDLE)
  assert.strictEqual(states[states.length - 1].detail, 'disconnected')
})

test('queued fragments are dropped when the link goes away', async () => {
  // Half a message arriving after a reconnect would be read as garbage by the
  // far side, on a link where every byte is authenticated.
  const radio = createFakeRadio()
  const { session } = await connected(radio)

  session.send(new Uint8Array(200))
  const sentBeforeDrop = radio.writes().length
  radio.dropConnection()

  await settle(600)
  assert.strictEqual(radio.writes().length, sentBeforeDrop,
    'fragments kept going out after the car was gone')
})

// Zepp's typings and Zepp's own easy-ble disagree about how the mstOn* callbacks
// deliver arguments, and being wrong is silent: every field reads undefined and
// the handler concludes nothing happened. Taking the object side of that bet is
// what produced "car out of range" from the driver's seat -- prepare reported a
// status of undefined, that compared unequal to zero, so preparation was
// declared failed, notifications were never enabled, and the car dropped a
// connection nobody had spoken on. Both conventions are exercised here so
// neither can be the one that was guessed wrong.
for (const convention of ['object', 'positional']) {
  const positional = convention === 'positional'

  test('the link comes up with ' + convention + ' callback arguments', async () => {
    const radio = createFakeRadio({ positional })
    const { session } = await connected(radio)

    assert.strictEqual(session.state, STATE.READY,
      'never became usable with ' + convention + ' callbacks')
    assert.ok(radio.types().includes('writeDescriptor'),
      'notifications were never enabled with ' + convention + ' callbacks')
  })

  test('notifications are received with ' + convention + ' callback arguments', async () => {
    const radio = createFakeRadio({ positional })
    const { session } = await connected(radio)

    const received = []
    session.onMessage((message) => received.push(message))

    // A whole one-fragment message: two-byte big-endian length, then the body.
    const body = new Uint8Array([1, 2, 3, 4])
    const framed = new Uint8Array(2 + body.length)
    framed[0] = 0
    framed[1] = body.length
    framed.set(body, 2)

    radio.notify({ uuid: NOTIFY, data: framed.buffer, length: framed.length })

    assert.strictEqual(received.length, 1,
      'nothing arrived with ' + convention + ' callbacks')
    assert.deepStrictEqual(received[0], body)
  })

  test('writes stay flow-controlled with ' + convention + ' callback arguments', async () => {
    const radio = createFakeRadio({ positional })
    const { session } = await connected(radio)

    session.send(new Uint8Array(120))
    assert.strictEqual(radio.writes().length, 1)

    let guard = 0
    while (radio.writesOutstanding > 0 && guard < 100) { radio.completeWrite(); guard++ }

    assert.ok(radio.writes().length > 1, 'the queue never drained')
    assert.ok(!radio.crashed, radio.faults.join('; '))
  })
}

test('a real preparation failure is still reported', async () => {
  // Tolerating an absent status must not turn into tolerating a stated one.
  const radio = createFakeRadio()
  const ctx = open(radio)
  ctx.session.connect(CAR)
  radio.advertise(CAR)
  await settle()
  radio.completeConnection()
  await settle()
  radio.completePrepare(133)

  assert.strictEqual(ctx.session.state, STATE.FAILED)
  assert.ok(/133/.test(ctx.states[ctx.states.length - 1].detail))
})

test('sending is refused before the link is ready', async () => {
  const radio = createFakeRadio()
  const { session } = open(radio)

  assert.strictEqual(session.send(new Uint8Array(10)), false)
  assert.strictEqual(radio.writes().length, 0, 'wrote with no connection')
})

// --- Regressions ---

test('a late write completion does not release the next fragment as well', async () => {
  // The subtle half of the write flood, and the one no earlier test could see.
  //
  // The fallback timer and the stack's own completion callback are two sources
  // of "that write is done", and nothing in the API says which write a
  // completion belongs to. When a controller reports late -- a long connection
  // interval during a retransmission is enough -- the timer releases fragment N
  // and the real completion for N then arrives and releases N+1 as well. From
  // there the queue runs permanently one ahead: two fragments outstanding, for
  // the rest of the message, in exactly the congested conditions that made the
  // controller slow in the first place.
  const radio = createFakeRadio()
  const { session } = await connected(radio, { writeTimeoutMs: 100 })

  session.send(new Uint8Array(120))
  assert.strictEqual(radio.writes().length, 1, 'more than one fragment went out at once')

  // Long enough for the fallback to give up on fragment 1 and release fragment
  // 2, and short enough that fragment 2's own fallback has not yet fired.
  await settle(150)
  const afterTimeout = radio.writes().length
  assert.strictEqual(afterTimeout, 2, 'the fallback timer did not move the queue on')

  // Releasing fragment 2 while fragment 1 is unaccounted for is the fallback
  // doing its job, and the radio rightly records it. That one overlap is the
  // price of not wedging the queue; what must not happen is a second one.
  const faultsFromTheFallback = radio.faults.length
  assert.strictEqual(faultsFromTheFallback, 1,
    'expected exactly the fallback overlap: ' + radio.faults.join('; '))

  // Now the stack finally reports fragment 1. It must be recognised as an
  // answer to a fragment already abandoned, not credited to fragment 2.
  radio.completeWrite()
  assert.strictEqual(radio.writes().length, afterTimeout,
    'a late completion released another fragment while one was still in flight')
  assert.strictEqual(radio.faults.length, faultsFromTheFallback,
    'the late completion started a second overlapping write: ' + radio.faults.join('; '))
})

test('the first fragment does not race the CCCD write', async () => {
  // Enabling notifications is a GATT operation like any other. READY is
  // announced the moment it goes out, and the controller answers by sending its
  // handshake down the same callback, so without a gate every connection begins
  // with two operations outstanding at once.
  const radio = createFakeRadio()
  const ctx = open(radio)
  ctx.session.connect(CAR)
  radio.advertise(CAR)
  await settle()
  radio.completeConnection()
  await settle()
  radio.completePrepare()

  assert.strictEqual(ctx.session.state, STATE.READY, 'the link never came up')
  assert.ok(radio.types().includes('writeDescriptor'), 'notifications were never enabled')

  // A send at this instant is what the controller really does.
  ctx.session.send(new Uint8Array(60))
  assert.strictEqual(radio.writes().length, 0,
    'a fragment was written while the CCCD write was still outstanding')

  await settle()
  assert.ok(radio.writes().length > 0, 'the queue never resumed after the CCCD settled')
  assert.ok(!radio.crashed, radio.faults.join('; '))
})

test('a retry after a failure does not stack a second link on the first', async () => {
  // A failure that happens once the link is up -- a rejected write, a profile
  // that would not prepare -- leaves a connection open and a profile allocated.
  // connect() accepts FAILED as a starting state, so without teardown the retry
  // scans and connects on top of both, then overwrites the handle to the
  // profile and leaks it: the same freed-while-in-use fault as the old close(),
  // reached from the retry path instead.
  // Taken all the way up first, so a pointer is actually held: the failure
  // this guards against is one that happens *after* the link is usable, and a
  // preparation that fails never yields a profile to leak in the first place.
  const radio = createFakeRadio()
  const { session } = await connected(radio)

  radio.rejectNextWrite()
  session.send(new Uint8Array([1, 2, 3]))
  await settle()

  assert.strictEqual(session.state, STATE.FAILED, 'the rejected write was not reported')
  assert.ok(radio.isConnected, 'precondition: the link is still open after the failure')
  assert.ok(radio.profileAlive, 'precondition: the profile is still allocated')

  session.connect(CAR)
  assert.ok(!radio.isConnected, 'the old connection was left open across the retry')
  assert.ok(!radio.profileAlive, 'the old profile was leaked across the retry')
  assert.ok(!radio.crashed, radio.faults.join('; '))
})

test('a connect result arriving after close does not revive the session', async () => {
  // mstConnect's callback cannot be taken back: mstOffAllCb only covers the
  // mstOn* hooks. A result landing after teardown used to walk the session back
  // up to READY, firing at a page that no longer exists and leaving a GATT link
  // nothing would ever close.
  const radio = createFakeRadio()
  const ctx = open(radio)
  ctx.session.connect(CAR)
  radio.advertise(CAR)
  await settle()

  ctx.session.close()
  assert.strictEqual(ctx.session.state, STATE.IDLE)

  radio.completeConnection()
  await settle()

  assert.strictEqual(ctx.session.state, STATE.IDLE, 'a closed session was brought back up')
  assert.ok(!ctx.states.some((s) => s.state === STATE.READY),
    'READY was announced after the session was closed')
})
