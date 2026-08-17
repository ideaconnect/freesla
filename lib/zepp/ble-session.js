// The BLE conversation with the vehicle, with the radio API passed in.
//
// Everything that decides *what* to do lives here and imports nothing from
// @zos, so it can be driven against a fake radio in tests. lib/zepp/ble-transport.js
// is the thin binding that supplies the real one -- the same split as
// lib/zepp/storage.js over lib/app/settings-store.js, and for the same reason:
// this file had no coverage at all, and the faults it shipped with were the
// kind a test can catch. Writes with no flow control, a scan that never ended,
// and a teardown that freed a profile still in use -- each of which can take
// the watch's Bluetooth stack down with it.
//
// The connection sequence Zepp OS requires is: scan for the advertised name,
// connect to get a connection id, register mstOnPrepare, then call
// mstBuildProfile -- which both declares the layout and performs the discovery,
// handing back a profile pointer through that callback -- and finally enable
// notifications by writing the CCCD.
//
// mstPrepare and mstGetProfileInstance are not part of it. The typings imply
// otherwise and cost this app a fault that reset the watch; see the comment at
// the mstBuildProfile call for what the evidence actually says.

import { frameMessage, createReassembler } from '../tesla/framing.js'
import { STATE } from './ble-states.js'

// Assigned by the Bluetooth SIG for client characteristic configuration.
const CCCD_UUID = '00002902-0000-1000-8000-00805f9b34fb'
const ENABLE_NOTIFICATIONS = new Uint8Array([0x01, 0x00])

// Conservative: 23-byte default MTU leaves 20 bytes of payload per write. The
// Zepp API exposes no MTU negotiation, so assuming more risks silent truncation.
const DEFAULT_CHUNK_SIZE = 20

const PROFILE_NAME = 'freesla'

// How long to wait for a write to be acknowledged before assuming the stack
// will not report it and moving on.
const WRITE_TIMEOUT_MS = 400

// A scan with no answer used to run forever: the callback simply never fired,
// so nothing stopped it and nothing told the wearer. An idle BLE scan is also
// the most expensive thing this app can leave running.
const SCAN_TIMEOUT_MS = 20000

// The stack needs a breath between ending a scan and opening a connection.
// Connecting while the scan is still tearing down is the other half of the
// same class of fault as the write flood.
const POST_SCAN_SETTLE_MS = 120

// How long the CCCD write holds the queue's one-in-flight slot when the stack
// does not report its completion.
//
// Short on purpose, and shorter than WRITE_TIMEOUT_MS. mstOnCharaWriteComplete
// is named for characteristics and may well never fire for a descriptor, so
// this is paid on every connection; charging the full write timeout for it
// would put nearly half a second between the link coming up and the handshake
// going out, to avoid an overlap that lasts microseconds.
const CCCD_SETTLE_MS = 60

// How long to leave between registering the prepare callback and asking for
// the profile. The same 50ms Zepp's own easy-ble waits at this point; without
// it the callback silently never fires.
const PREPARE_DELAY_MS = 50

// How long to wait for mstOnPrepare before giving up on it.
//
// Discovery has no other end. Without this a stack that never calls back --
// which is one of the things a stack does when it has been asked to walk a
// profile it cannot walk -- leaves the screen on "finding the profile" with
// nothing to move it, and the connection still open behind it.
const PREPARE_TIMEOUT_MS = 8000

export { STATE } from './ble-states.js'

// Zepp's published typings and Zepp's own easy-ble library disagree about how
// the mstOn* callbacks deliver their arguments: the typings say positional, and
// easy-ble reads a single object. This code used to take the object side of
// that bet across the board, and being wrong about it is silent -- every field
// reads back undefined and the callback quietly decides nothing happened.
//
// That is not a bet worth taking twice. mstOnPrepare's status came back
// undefined, compared unequal to 0, and reported a preparation failure that had
// not happened; notifications were never enabled, so the car sat there with a
// connection nobody spoke on and dropped it a few seconds later, which the
// screen then reported as the car being out of range while its owner sat in it.
//
// So both shapes are accepted. An object first argument is the object form;
// anything else is positional.
function readPrepare (first, second) {
  if (first && typeof first === 'object') {
    return { profile: first.profile, status: first.status }
  }
  return { profile: first, status: second }
}

function readNotification (first, second, third, fourth) {
  if (first && typeof first === 'object') {
    return { uuid: first.uuid, data: first.data, length: first.length }
  }
  return { uuid: second, data: third, length: fourth }
}

function readWriteComplete (first, second, third) {
  if (first && typeof first === 'object') {
    return { status: first.status }
  }
  return { status: third }
}

export function createBleSession (ble, options) {
  const serviceUuid = options.serviceUuid
  const writeUuid = options.writeUuid
  const notifyUuid = options.notifyUuid
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE
  const log = options.log || function () {}

  // Overridable so tests need not sit through the real ones. The defaults are
  // what runs on the watch.
  //
  // Compared against undefined rather than tested for truthiness: every one of
  // these is a duration, and 0 is a meaningful value for all of them -- "do not
  // wait" is exactly what a test wants to say. `||` would silently substitute
  // the multi-hundred-millisecond default for it.
  const writeTimeoutMs = options.writeTimeoutMs === undefined
    ? WRITE_TIMEOUT_MS
    : options.writeTimeoutMs
  const scanTimeoutMs = options.scanTimeoutMs === undefined
    ? SCAN_TIMEOUT_MS
    : options.scanTimeoutMs
  const postScanSettleMs = options.postScanSettleMs === undefined
    ? POST_SCAN_SETTLE_MS
    : options.postScanSettleMs
  const cccdSettleMs = options.cccdSettleMs === undefined
    ? CCCD_SETTLE_MS
    : options.cccdSettleMs
  const prepareDelayMs = options.prepareDelayMs === undefined
    ? PREPARE_DELAY_MS
    : options.prepareDelayMs
  const prepareTimeoutMs = options.prepareTimeoutMs === undefined
    ? PREPARE_TIMEOUT_MS
    : options.prepareTimeoutMs

  let state = STATE.IDLE
  let connectId = null
  let profile = null
  let deviceAddress = null
  let messageHandler = null
  let stateHandler = options.onState || function () {}
  let lastRssi = null
  // Receives every advertisement seen during a scan. Nearby addresses and their
  // signal strengths are the least predictable thing the watch can observe, so
  // they are offered up as entropy.
  const observationHandler = options.onObservation || function () {}
  const reassembler = createReassembler()

  // One fragment on the wire at a time; see send().
  const writeQueue = []
  let writeInFlight = false
  let writeTimer = null
  let scanTimer = null
  // Set between the CCCD write going out and the queue being allowed to use
  // the radio. Kept apart from writeInFlight deliberately: the descriptor write
  // may never be reported complete, so it must not be entered into the
  // completion accounting below, where an acknowledgement that never arrives
  // would be owed forever.
  let cccdSettling = false
  let cccdTimer = null
  // Bounds GATT discovery; see startPrepareTimer.
  let prepareTimer = null
  // Writes the fallback timer gave up on. The stack may still report those
  // later, and such a report belongs to a fragment we have already moved past
  // -- crediting it to the one currently in flight would free the slot twice
  // and put two fragments on the wire, which is the flood this queue exists to
  // stop. Counted rather than flagged, because more than one can pile up.
  let abandonedWrites = 0

  function clearScanTimer () {
    if (scanTimer !== null) {
      clearTimeout(scanTimer)
      scanTimer = null
    }
  }

  function clearPrepareTimer () {
    if (prepareTimer !== null) {
      clearTimeout(prepareTimer)
      prepareTimer = null
    }
  }

  // Armed immediately before mstPrepare, so it covers the whole of discovery.
  function startPrepareTimer () {
    clearPrepareTimer()
    if (prepareTimeoutMs <= 0) return
    prepareTimer = setTimeout(() => {
      prepareTimer = null
      if (state !== STATE.PREPARING) return
      // Said in terms of what was being done rather than which call was made:
      // whoever reads this is standing next to a car, not in this file.
      fail('The car stopped responding while setting up. Try again.')
    }, prepareTimeoutMs)
  }

  // When the current connection attempt began, for the elapsed figures below.
  let attemptStartedAt = 0

  // Milliseconds since this attempt started.
  //
  // The one number worth having on every line. A watch that resets leaves no
  // report of its own, so the log kept by whatever is reading the console --
  // and the car's trace at the other end -- are the only accounts of it. Both
  // are read the same way: not by what the last entry says, but by how long
  // the gap after it is.
  function elapsed () {
    return attemptStartedAt === 0 ? 0 : Date.now() - attemptStartedAt
  }

  function setState (next, detail) {
    state = next
    log('+' + elapsed() + 'ms  ble ' + next + (detail ? ': ' + detail : ''))
    stateHandler(next, detail)
  }

  // A step within a state, for the screen and the log.
  //
  // Connecting used to be one word covering the scan, the connection, three
  // separate stack calls to declare and discover the GATT profile, and the
  // descriptor write that enables notifications. Any of those can be the last
  // thing this watch ever does, and they were indistinguishable from each
  // other -- on the screen and in the log alike.
  //
  // Reported synchronously, on purpose, including from inside the stack's own
  // callbacks. Deferring the paint by a tick would be cheaper for the callback
  // -- but a watch that dies inside one never runs that tick, so the screen
  // would freeze on the step *before* the fatal one and misattribute it by
  // exactly one line. The screen is the only account of this fault that a
  // person can read while it is happening, so it has to be right.
  //
  // What that costs is kept small at the other end instead: a step changes the
  // caption and nothing else, and page/index.js repaints only the caption when
  // only the caption has changed.
  function step (detail) {
    log('+' + elapsed() + 'ms  ' + detail)
    stateHandler(state, detail)
  }

  function clearWriteTimer () {
    if (writeTimer !== null) {
      clearTimeout(writeTimer)
      writeTimer = null
    }
  }

  function resetWrites () {
    clearWriteTimer()
    if (cccdTimer !== null) {
      clearTimeout(cccdTimer)
      cccdTimer = null
    }
    cccdSettling = false
    writeQueue.length = 0
    writeInFlight = false
    abandonedWrites = 0
  }

  // The stack reporting a write done. Never assume it is the write we are
  // waiting on: the API gives no way to correlate a completion with a
  // particular write, so the only thing that can be tracked is how many
  // completions are still owed for fragments the timer already released.
  function onWriteComplete () {
    if (abandonedWrites > 0) {
      abandonedWrites--
      log('a late completion arrived for a fragment already given up on')
      return
    }
    if (!writeInFlight) return
    clearWriteTimer()
    writeInFlight = false
    pumpWrites()
  }

  // Nothing came back in time. Moving on is still better than wedging the
  // queue, but the fragment is now unaccounted for, so its eventual completion
  // must not be allowed to release somebody else's slot.
  function onWriteTimedOut () {
    writeTimer = null
    if (!writeInFlight) return
    abandonedWrites++
    writeInFlight = false
    log('a write was not acknowledged within ' + writeTimeoutMs + 'ms')
    pumpWrites()
  }

  function pumpWrites () {
    if (writeInFlight || writeQueue.length === 0) return
    if (state !== STATE.READY || profile === null || profile === undefined) {
      // The link went away with fragments still queued; half a message is worse
      // than none, so the rest is dropped and the reassembler on the far side
      // will time the partial one out.
      resetWrites()
      return
    }
    // Notifications are still being switched on. Anything sent now would be a
    // second GATT operation on top of the descriptor write, and a car that
    // answered before the CCCD landed would be talking to a client that is not
    // yet listening.
    if (cccdSettling) return

    const chunk = writeQueue.shift()
    writeInFlight = true

    let accepted = false
    try {
      accepted = ble.mstWriteCharacteristic(profile, writeUuid, chunk.buffer, chunk.length)
    } catch (e) {
      log('write threw: ' + e.message)
      resetWrites()
      fail('write failed')
      return
    }

    if (accepted === false) {
      log('write rejected by the stack')
      resetWrites()
      fail('write rejected')
      return
    }

    // Belt and braces: if the completion callback never arrives, carry on
    // rather than wedging the queue.
    writeTimer = setTimeout(onWriteTimedOut, writeTimeoutMs)
  }

  function fail (reason) {
    setState(STATE.FAILED, reason)
  }

  // Gives the connection and its profile back to the stack, in the order the
  // stack expects: drop the link first, and only then destroy the profile.
  // Destroying a profile while its connection is still open was asking the
  // firmware to free something it was still using.
  //
  // Shared by close() and by connect(), which needs it because a failure can
  // leave a link up: reconnecting on top of one is the same fault from the
  // other direction.
  function releaseLink () {
    try {
      if (connectId !== null && connectId !== undefined) ble.mstDisconnect(connectId)
    } catch (e) {
      log('disconnect error: ' + e.message)
    }
    try {
      if (profile !== null && profile !== undefined) ble.mstDestroyProfileInstance(profile)
    } catch (e) {
      log('profile teardown error: ' + e.message)
    }
    profile = null
    connectId = null
  }

  // The published typings declare positional callback arguments, but the
  // runtime passes a single object. Zepp's own easy-ble library confirms the
  // object form; following the typings here yields undefined for every field.
  // Wrapped whole, and deliberately so: this runs on a native callback, and a
  // throw crossing back into the Bluetooth stack is not something the runtime
  // recovers from gracefully. A malformed notification must cost us one
  // message, not the watch.
  function handleNotification (first, second, third, fourth) {
    try {
      const event = readNotification(first, second, third, fourth)
      const uuid = event.uuid
      const data = event.data
      const length = event.length
      if (!uuid || uuid.toLowerCase() !== notifyUuid.toLowerCase()) return
      if (!data) return

      // The ArrayBuffer belongs to the native layer and may be reused, so the
      // bytes are copied out before they reach the reassembler. The length is
      // clamped rather than trusted: a value past the end of the buffer would
      // throw here, in the worst possible place to throw.
      const available = data.byteLength === undefined ? 0 : data.byteLength
      const take = length === undefined ? available : Math.min(length, available)
      if (take <= 0) return

      const chunk = new Uint8Array(take)
      chunk.set(new Uint8Array(data, 0, take))

      let messages
      try {
        messages = reassembler.push(chunk)
      } catch (e) {
        log('framing error: ' + e.message)
        reassembler.reset()
        return
      }

      for (const message of messages) {
        if (messageHandler) messageHandler(message)
      }
    } catch (e) {
      log('notification handler error: ' + e.message)
    }
  }

  // Declares the layout we expect, which is also what starts discovery.
  //
  // The count fields are the part worth being careful about. Zepp's published
  // typings describe five of them; the native profile walker reads eight, and
  // the three it does not document are not optional. Zepp's own easy-ble
  // supplies all eight and annotates two of them `*R` -- required -- with the
  // note that the third level "REQUIRES len2 despite docs stating otherwise".
  //
  // A count the native side reads as undefined is a count it takes from
  // whatever was in that memory, and it is only spent later, when discovery
  // walks the structure it sized. mstBuildProfile returns true either way.
  //
  // `pair` stays false where easy-ble uses true: a Tesla does not bond, its
  // authentication is the protocol above this one.
  function buildProfile () {
    const ok = ble.mstBuildProfile({
      pair: false,
      id: connectId,
      profile: PROFILE_NAME,
      dev: deviceAddress,
      len: 1,
      list: [{
        // Not documented anywhere; taken verbatim from the only implementation
        // known to complete discovery on this stack.
        uuid: true,
        size: 1,
        len: 1,
        list: [{
          uuid: serviceUuid,
          permission: 0,
          len1: 2,
          len2: 2,
          list: [
            // No descriptors, and so no `list` at all rather than an empty
            // one: easy-ble omits the key in this case, and an empty array is
            // exactly the kind of thing a walker counts differently from an
            // absent one.
            { uuid: writeUuid, permission: 0, desc: 0, len: 0 },
            {
              uuid: notifyUuid,
              permission: 0,
              desc: 1,
              len: 1,
              list: [{ uuid: CCCD_UUID, permission: 0 }]
            }
          ]
        }]
      }]
    })

    if (!ok) {
      fail('could not build the GATT profile')
      return false
    }
    return true
  }

  function onPrepared (first, second) {
    try {
      const event = readPrepare(first, second)

      // Only an explicit non-zero status is a failure. An absent one means this
      // runtime does not report it, and refusing to continue on that basis is
      // what left the link connected but silent.
      if (event.status !== undefined && event.status !== null && event.status !== 0) {
        fail('profile preparation failed with status ' + event.status)
        return
      }

      // This callback is the only source of the profile pointer: nothing else
      // in the API returns one -- mstBuildProfile answers a plain boolean --
      // and every later operation on the link is addressed by it.
      if (event.profile !== undefined && event.profile !== null) {
        profile = event.profile
      }
      if (profile === null || profile === undefined) {
        fail('the car prepared no profile to talk to')
        return
      }

      // Discovery came back, so its deadline is done with. Cleared before
      // anything below can fail, or a failure here would be reported twice --
      // once for itself and once by a timer nobody stopped.
      clearPrepareTimer()

      step('the car answered; registering for notifications')
      ble.mstOnCharaNotification(handleNotification)
      // Drives the write queue. Registered before anything is written, so the
      // very first fragment is already under flow control.
      ble.mstOnCharaWriteComplete((a, b, c) => {
        try {
          const done = readWriteComplete(a, b, c)
          if (done.status !== undefined && done.status !== 0) {
            log('write reported status ' + done.status)
          }
          onWriteComplete()
        } catch (e) {
          log('write-complete handler error: ' + e.message)
        }
      })

      // READY is announced synchronously below, and the controller sends its
      // handshake straight back down this same callback. Without a gate here
      // that first fragment goes out on top of the descriptor write -- one
      // guaranteed overlapping GATT operation per connection, of exactly the
      // kind the queue exists to prevent.
      cccdSettling = true
      cccdTimer = setTimeout(() => {
        cccdTimer = null
        cccdSettling = false
        pumpWrites()
      }, cccdSettleMs)

      step('switching notifications on')
      ble.mstWriteDescriptor(profile, notifyUuid, CCCD_UUID, ENABLE_NOTIFICATIONS.buffer, 2)
      setState(STATE.READY)
    } catch (e) {
      fail('profile preparation error: ' + e.message)
    }
  }

  function onConnectResult (result) {
    try {
      if (!result) return

      if (result.connected === 2) {
        // The vehicle dropped us — expected on walk-away. Only worth reporting
        // if we still thought we had a link; after close() the drop is our own
        // doing and announcing it would put "Car out of range" on a screen the
        // owner has already left.
        if (state === STATE.IDLE) return
        clearScanTimer()
        clearPrepareTimer()
        resetWrites()
        reassembler.reset()
        profile = null
        connectId = null
        setState(STATE.IDLE, 'disconnected')
        return
      }

      // The callback handed to mstConnect cannot be taken back -- mstOffAllCb
      // covers the mstOn* hooks only -- so a result can land after close() or
      // after the attempt was abandoned. Carrying on would walk a torn-down
      // session back up to READY, firing at a page that no longer exists and
      // leaving a GATT link nothing will ever close.
      if (state !== STATE.CONNECTING) {
        log('ignoring a connect result arriving in state ' + state)
        if (result.connected === 0 && result.connect_id !== undefined) {
          try {
            ble.mstDisconnect(result.connect_id)
          } catch (e) {
            log('could not close an unwanted connection: ' + e.message)
          }
        }
        return
      }

      if (result.connected !== 0) {
        fail('connection refused')
        return
      }

      connectId = result.connect_id
      setState(STATE.PREPARING, 'link open')

      // Two calls, in this order, with a breath between them -- and nothing
      // else. This is the whole of GATT setup on this platform.
      //
      // It used to be four. mstBuildProfile was treated as a declaration, and
      // the profile was then resolved with mstGetProfileInstance and handed to
      // mstPrepare to be discovered on the peer. That reading is wrong, and it
      // is what was resetting the watch:
      //
      //   mstBuildProfile is documented as "creating a Profile connection" and
      //   is itself what starts discovery and what eventually fires
      //   mstOnPrepare. The pointer arrives as that callback's argument --
      //   which is the only place it can come from, since mstBuildProfile
      //   returns a boolean. Zepp's own easy-ble calls exactly these two
      //   functions and contains no reference to mstPrepare or
      //   mstGetProfileInstance at all, and neither appears in the official
      //   master-mode flow diagram.
      //
      // So mstPrepare was a second discovery, started on a profile whose first
      // one was still running: the app's own timings proved it, because had
      // the first completed, onPrepared would have moved the state on and the
      // guard below would have skipped the second. Re-entering native GATT
      // discovery is the class of fault this file already treats as fatal
      // everywhere else.
      //
      // The 50ms is the delay easy-ble uses in the same place, for the same
      // reason: the callback silently never fires without it.
      ble.mstOnPrepare(onPrepared)
      setTimeout(() => {
        if (state !== STATE.PREPARING) return
        try {
          // Armed before the call, because the call *is* the discovery.
          startPrepareTimer()
          step('asking the car for its profile')
          if (!buildProfile()) return
        } catch (e) {
          fail('profile setup failed: ' + e.message)
        }
      }, prepareDelayMs)
    } catch (e) {
      log('connect handler error: ' + e.message)
    }
  }

  return {
    get state () {
      return state
    },

    // Signal strength of the advertisement we connected to, as a proximity
    // proxy. Null until a car has been found.
    get rssi () {
      return lastRssi
    },

    onMessage (handler) {
      messageHandler = handler
    },

    onState (handler) {
      stateHandler = handler
    },

    // Scans for a peripheral advertising `deviceName` and connects to it.
    // Tesla's advertised name is derived from the VIN, so this identifies one
    // specific car without needing its MAC address stored anywhere.
    connect (deviceName) {
      if (state !== STATE.IDLE && state !== STATE.FAILED) {
        log('connect ignored while in state ' + state)
        return false
      }

      // A retry after a failure that happened *after* the link came up -- a
      // rejected write, a profile that would not prepare -- would otherwise
      // scan and connect on top of a connection still open and a profile still
      // allocated, then overwrite the handle to that profile and leak it. That
      // is the freed-while-in-use fault this file was rewritten to avoid, just
      // reached from the retry path instead of from teardown.
      releaseLink()

      reassembler.reset()
      resetWrites()
      attemptStartedAt = Date.now()
      setState(STATE.SCANNING, 'looking for ' + deviceName)

      let settled = false
      // What else was advertising, so a scan that finds nothing can say what it
      // did see rather than only what it wanted. The name has to match exactly,
      // and every way of getting it slightly wrong -- a mock car advertising
      // under its machine's name, a VIN with a transposed character -- looks
      // from here exactly like a car that is not there. Capped, because a
      // station car park is a lot of advertisements.
      const namesSeen = []

      const stopScanning = () => {
        clearScanTimer()
        try {
          ble.mstStopScan()
        } catch (e) {
          log('stop scan error: ' + e.message)
        }
      }

      // Whole callback guarded: it runs on a native BLE callback, where a throw
      // is not survivable.
      const started = ble.mstStartScan((result) => {
        try {
          if (settled || !result) return

          // Fold every advertisement into the entropy pool, not just our car's.
          try {
            if (result.dev_addr) {
              const observed = new Uint8Array(8)
              observed.set(new Uint8Array(result.dev_addr, 0, 6))
              observed[6] = result.rssi & 0xff
              observed[7] = (Date.now() & 0xff)
              observationHandler(observed)
            }
          } catch (e) {
            // Never let entropy collection break a connection attempt.
          }

          if (result.dev_name !== deviceName || !result.dev_addr) {
            if (result.dev_name && namesSeen.length < 8 &&
                namesSeen.indexOf(result.dev_name) < 0) {
              namesSeen.push(result.dev_name)
            }
            return
          }

          settled = true
          lastRssi = result.rssi
          stopScanning()

          // Copy the address: the scan result's buffer is not ours to keep.
          const addr = new Uint8Array(6)
          addr.set(new Uint8Array(result.dev_addr, 0, 6))
          deviceAddress = addr.buffer

          setState(STATE.CONNECTING, 'found it at ' + result.rssi + ' dBm')

          // Not connected from inside the scan callback. The stack is still
          // unwinding the scan at this point, and opening a connection on top
          // of that is the kind of thing that takes the whole stack out.
          setTimeout(() => {
            if (state !== STATE.CONNECTING) return
            try {
              step('opening the link')
              if (!ble.mstConnect(deviceAddress, onConnectResult)) fail('connect call rejected')
            } catch (e) {
              fail('connect failed: ' + e.message)
            }
          }, postScanSettleMs)
        } catch (e) {
          log('scan handler error: ' + e.message)
        }
      }, { device_name: deviceName })

      if (!started) {
        fail('could not start scanning')
        return false
      }

      // Nothing else ends a fruitless scan, and leaving the radio sweeping
      // indefinitely is both a battery drain and a state the screen can never
      // move out of.
      scanTimer = setTimeout(() => {
        if (settled || state !== STATE.SCANNING) return
        stopScanning()
        // The empty case is worded carefully. mstStartScan is given the name as
        // a filter, and a stack that honours it will only ever deliver matches
        // -- so seeing nothing else is not evidence that there was nothing
        // else, and saying "the air was empty" would be a claim this code
        // cannot make. What it can say is what reached the callback.
        log(namesSeen.length === 0
          ? 'no other named advertisement reached the scan while looking for ' + deviceName +
            ' (the radio may be filtering the scan to that name)'
          : 'looked for ' + deviceName + ', saw ' + namesSeen.join(', '))
        fail('Car not found. Stand next to it and try again.')
      }, scanTimeoutMs)

      return true
    },

    // Writes one protocol message, fragmented to fit the MTU.
    //
    // Queued, one fragment in flight at a time. This used to push every
    // fragment in a synchronous loop, which is the fastest way there is to
    // overrun the controller's transmit queue: nothing in the API applies back
    // pressure, so a handshake of a few hundred bytes went out as a dozen
    // back-to-back writes with no gap at all. On hardware that takes the
    // Bluetooth stack down and the watch with it.
    //
    // mstOnCharaWriteComplete is the stack telling us a fragment has actually
    // gone, so it drives the queue. The timer is a fallback for a controller
    // that does not report completion, so a lost callback stalls one message
    // rather than every message forever.
    send (message) {
      if (state !== STATE.READY) {
        log('send refused in state ' + state)
        return false
      }

      const chunks = frameMessage(message, chunkSize)
      for (const chunk of chunks) {
        // subarray views share the parent buffer, so each chunk is copied into
        // a standalone buffer before being handed to the native layer.
        const owned = new Uint8Array(chunk.length)
        owned.set(chunk)
        writeQueue.push(owned)
      }
      pumpWrites()
      return true
    },

    // Torn down in the order the stack expects; see releaseLink.
    close () {
      clearScanTimer()
      clearPrepareTimer()
      resetWrites()

      try {
        if (state === STATE.SCANNING) ble.mstStopScan()
      } catch (e) {
        log('close: stop scan error: ' + e.message)
      }
      try {
        ble.mstOffAllCb()
      } catch (e) {
        log('close: callback removal error: ' + e.message)
      }

      releaseLink()
      deviceAddress = null
      reassembler.reset()
      setState(STATE.IDLE, 'closed')
    }
  }
}

