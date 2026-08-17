// Application controller: the state machine the UI renders.
//
// Keeps the page free of protocol detail. Everything is callback-driven --
// async/await is unsupported on this runtime and hangs the app rather than
// failing loudly.

import { STATE as BLE_STATE } from '../zepp/ble-states.js'
import { createClient } from '../tesla/client.js'
import { createNonceSource } from '../tesla/nonce.js'
import { SERVICE_UUID, WRITE_UUID, NOTIFY_UUID, ROLE, KEY_FORM_FACTOR } from '../tesla/constants.js'
import { expectedLocalName, localNameOverride } from './device-name.js'
import { createBreadcrumb } from './breadcrumb.js'
import { createIdentity } from './identity.js'
import { REASON } from './phone.js'
import { createDrbg, collectWatchEntropy } from '../crypto/random.js'

export const STATE = {
  NEEDS_VIN: 'needs-vin',
  NEEDS_KEY: 'needs-key',
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  NEEDS_ENROLMENT: 'needs-enrolment',
  ENROLLING: 'enrolling',
  READY: 'ready',
  BUSY: 'busy',
  ERROR: 'error'
}

export function createController (options) {
  const storage = options.storage
  const log = options.log || function () {}
  const onChange = options.onChange || function () {}
  // Injected rather than imported so the controller carries no @zos dependency
  // and can be exercised against the mock vehicle.
  const createTransport = options.createTransport

  const identity = createIdentity(storage)
  const onStatusChange = options.onStatusChange || function () {}
  // Turns the vehicle's public key into a shared secret. On the watch this is a
  // round trip to the phone, because the curve maths behind it takes about 87
  // seconds here and 14ms there. Injected rather than imported for the same
  // reason createTransport is: the controller should carry no opinion about
  // which host it is running on.
  const deriveSharedSecret = options.deriveSharedSecret
  // A name to scan for in place of the one this VIN derives; see
  // lib/app/device-name.js. Left undefined by every caller on the watch, which
  // means "whatever this build was configured with" -- it is passed in only so
  // the behaviour can be tested without rebuilding.
  const bleNameOverride = options.bleNameOverride
  // Off unless the build asks for it; see freesla.config.js. Passed in only so
  // it can be exercised without a rebuild.
  const breadcrumb = createBreadcrumb(storage, options.breadcrumb)
  let connectStartedAt = 0
  // The command currently on the wire, for saying so when another is pressed.
  let runningCommand = null
  let state = STATE.DISCONNECTED
  let detail = ''
  let keys = null
  let transport = null
  let client = null
  let randomBytes = null
  let vehicleStatus = null
  let statusTrust = null
  // Auto-unlock fires once per approach. It re-arms only after the car has
  // gone out of range, so sitting parked beside it does not keep reopening
  // the doors after a manual lock.
  let autoUnlockArmed = true
  // Set when an enrolment step was asked for before the car was in range:
  // 'request' to ask the car to add this key, 'check' to probe whether it
  // already has. The step then runs by itself once the link comes up, so
  // "connect first" is never something the owner has to work out.
  let pendingEnrolmentStep = null
  // Bumped whenever the link is torn down. Anything still in flight from before
  // belongs to a connection that no longer exists and must not report back.
  let linkEra = 0

  function setState (next, message) {
    state = next
    detail = message || ''
    log('state ' + next + (message ? ': ' + message : ''))
    onChange(state, detail)
  }

  function ensureRandom () {
    // Seeded once the scan has had a chance to see something, so the
    // advertisements the radio picked up feed the pool. This produces routing
    // addresses and request uuids, never key material -- the key comes from
    // the phone precisely because this source is not good enough for one.
    if (!randomBytes) randomBytes = createDrbg(collectWatchEntropy(identity.entropySources()))
    return randomBytes
  }

  // Reports the one-time derivation on screen while the phone answers.
  //
  // The first handshake with a car is the only moment the phone is needed after
  // pairing, and it can take a second or two to wake up. Without this the
  // screen sits on "Unlock" looking like a command that went nowhere.
  function deriveWithProgress (privateKey, vehiclePublicKey, callback) {
    if (typeof deriveSharedSecret !== 'function') {
      callback(new Error('this watch cannot set up a new car on its own'))
      return
    }

    const resumeState = state
    const resumeDetail = detail
    const era = linkEra
    setState(state, 'First time with this car, asking your phone…')

    deriveSharedSecret(privateKey, vehiclePublicKey, (err, sharedX) => {
      // The link was torn down while the phone was thinking. The command this
      // belonged to is gone, and if another has started since, restoring the
      // old one's caption would paint it over the new one.
      if (era !== linkEra) return

      // Put back what was on screen, so whoever asked for the command reports
      // its outcome rather than this step's.
      if (state === STATE.BUSY || state === STATE.ENROLLING) setState(resumeState, resumeDetail)
      if (err) {
        // Only an absent phone gets the "stand closer" advice. A phone that
        // answered and declined has said something specific -- "the vehicle
        // public key is not a valid curve point" is a security signal, and
        // telling its owner to walk nearer would be advice that cannot work.
        callback(err.reason === REASON.REFUSED
          ? err
          : new Error('Bring your phone closer. A new car has to be set ' +
            'up once, and only your phone can do it.'))
        return
      }
      callback(null, sharedX)
    })
  }

  function refresh () {
    const vin = storage.getVin()
    if (!vin) {
      setState(STATE.NEEDS_VIN, 'Pair your car from the settings page on your phone.')
      return
    }
    if (!identity.hasTrustedKey()) {
      // A key left by an older build carries no record of how it was made, so
      // it is replaced rather than trusted.
      setState(STATE.NEEDS_KEY, identity.hasKey()
        ? 'This key was made before the app required your phone’s randomness. Create a new one.'
        : 'Tap to create this watch’s key')
      return
    }
    keys = identity.load()
    setState(storage.isEnrolled() ? STATE.DISCONNECTED : STATE.NEEDS_ENROLMENT,
      storage.isEnrolled() ? 'Tap to connect' : 'Add this key to your car')
  }

  function buildClient () {
    if (client) return client

    const random = ensureRandom()
    client = createClient({
      vin: storage.getVin(),
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      link: transport,
      randomBytes: random,
      nonceSource: createNonceSource(storage, random),
      // Namespaced by this watch's own public key: the secret depends on both
      // halves, so a key made after an old one must not read the old one's
      // cache entry.
      sessionKeyCache: storage.asSessionKeyCache(keys.publicKey),
      deriveSharedSecret: deriveWithProgress,
      onStatus (status, trust) {
        vehicleStatus = status
        // Never upgrade what we believe: an overheard broadcast arriving after
        // a verified reply must not make the display look more certain.
        statusTrust = trust
        log('status ' + trust + ': lock=' + status.lockState)
        onStatusChange(status, trust)
      },
      log
    })
    return client
  }

  // Drops the client, having first told it so.
  //
  // Dropping the reference alone is not enough: the client owns a request
  // timeout and possibly a derivation waiting on the phone, and both outlive
  // the reference. An abandoned timer fires seconds later and reports "command
  // timed out" over whatever screen the owner has moved on to, and an abandoned
  // derivation would apply session info to a link that is already closed.
  function discardClient () {
    linkEra++
    if (client) client.reset()
    client = null
  }

  function ensureTransport () {
    if (transport) return transport

    transport = createTransport({
      serviceUuid: SERVICE_UUID,
      writeUuid: WRITE_UUID,
      notifyUuid: NOTIFY_UUID,
      log,
      // Advertisements seen while scanning are the best entropy the watch can
      // reach without extra permissions, so they feed the key generator.
      onObservation (bytes) { identity.observe(bytes) },
      onState (bleState, bleDetail) {
        // Recorded only while an attempt is actually in flight.
        //
        // The terminal states have to clear it instead, and getting this wrong
        // makes the instrument lie rather than merely fall silent: close()
        // emits IDLE/'closed' synchronously from inside disconnect(), *after*
        // disconnect() has cleared the trail, so recording it would write a
        // clean exit back into the trail and have the next launch report a
        // crash that never happened -- and refuse to auto-connect because of
        // it.
        //
        // Guarded on `enabled` rather than left to record() to ignore: this
        // runs on a Bluetooth callback in a build that asked for none of it,
        // so it should not even read the clock.
        if (breadcrumb.enabled) {
          if (bleState === BLE_STATE.SCANNING ||
              bleState === BLE_STATE.CONNECTING ||
              bleState === BLE_STATE.PREPARING) {
            breadcrumb.record(bleDetail || bleState, connectStartedAt ? Date.now() - connectStartedAt : null)
          } else if (bleState !== BLE_STATE.READY) {
            // READY is not terminal for this purpose and clears itself below,
            // once the work it triggers has actually survived.
            breadcrumb.clear()
          }
        }

        if (bleState === BLE_STATE.FAILED) {
          // Deliberately not carried across a failure: enrolment is a one-way
          // security decision, so it is re-asked for rather than replayed from
          // an intent the owner expressed before something went wrong.
          pendingEnrolmentStep = null
          // The one place an override is visible on the watch itself. A build
          // that looks for the wrong name fails in exactly the way a car that
          // is genuinely out of range does, and this screen is where somebody
          // stands trying to work out which of the two they have.
          const override = state === STATE.CONNECTING
            ? localNameOverride(bleNameOverride)
            : null
          setState(STATE.ERROR, override
            ? (bleDetail || 'connection failed') + ' Built to look for ' + override + '.'
            : (bleDetail || 'connection failed'))
        } else if (bleState === BLE_STATE.SCANNING) setState(STATE.CONNECTING, 'Looking for your car')
        else if (bleState === BLE_STATE.CONNECTING) {
          setState(STATE.CONNECTING, bleDetail || 'Connecting')
        } else if (bleState === BLE_STATE.PREPARING) {
          // There was no branch here at all, and the omission was not
          // cosmetic. Everything from the link opening to notifications being
          // switched on -- three separate calls into the Bluetooth stack --
          // left the screen reading "Connecting", so a watch that died in the
          // middle of it took the only evidence of where with it. The step now
          // reaches the screen, which is the one part of this watch that
          // survives long enough to be photographed.
          setState(STATE.CONNECTING, bleDetail || 'Setting up the link')
        } else if (bleState === BLE_STATE.READY) {
          // Connecting says nothing about whether we hold a usable key, so the
          // blocker is re-derived rather than assumed away.
          const step = pendingEnrolmentStep
          pendingEnrolmentStep = null

          // Not cleared yet, despite the link being up. Everything below runs
          // synchronously inside the stack's own prepare callback -- building
          // the client, seeding the generator, reserving a nonce block against
          // flash, framing the handshake -- and that is the heaviest thing this
          // app does on a native callback. Clearing here would blind the trail
          // to exactly the window most worth watching.
          breadcrumb.record('link up, setting up the session',
            connectStartedAt ? Date.now() - connectStartedAt : null)

          if (!keys) {
            refresh()
          } else if (step && !storage.isEnrolled()) {
            if (step === 'check') runEnrolmentCheck()
            else sendEnrolment()
          } else {
            setState(storage.isEnrolled() ? STATE.READY : STATE.NEEDS_ENROLMENT,
              storage.isEnrolled() ? 'Connected' : 'Tap to add this key')
            maybeAutoUnlock()
          }

          // Reached the end of the callback alive, so the connection is not
          // what the next launch should be told about.
          breadcrumb.clear()
        } else if (bleState === BLE_STATE.IDLE && bleDetail === 'disconnected') {
          autoUnlockArmed = true
          pendingEnrolmentStep = null
          setState(STATE.DISCONNECTED, 'Car out of range')
        }
      }
    })
    return transport
  }

  // Unlocks on approach, without a button press. Requires the app to be open,
  // which the platform enforces anyway: Zepp OS has no background BLE.
  function maybeAutoUnlock () {
    if (!keys) return
    if (!storage.autoUnlockEnabled()) return
    if (!storage.isEnrolled()) return
    if (!autoUnlockArmed) return

    const rssi = transport ? transport.rssi : null
    const floor = storage.getMinRssi()
    if (rssi !== null && rssi < floor) {
      log('auto-unlock held back: rssi ' + rssi + ' below ' + floor)
      setState(STATE.READY, 'Connected, move closer')
      return
    }

    autoUnlockArmed = false
    log('auto-unlocking on approach at rssi ' + rssi)
    runCommand('Unlock', (c, cb) => c.unlock(cb))
  }

  function runCommand (name, invoke) {
    if (!keys) {
      refresh()
      return
    }
    if (state !== STATE.READY) {
      // The buttons stay on screen while a command is running, so pressing one
      // again is an ordinary thing to do -- and answering it with "Not
      // connected" was both wrong and alarming, since the car was right there
      // and the first command was on its way to it. Nothing is changed but
      // what the wearer is told.
      if (state === STATE.BUSY || state === STATE.ENROLLING) {
        // Named from what is running rather than from what is on screen: read
        // back from the caption, a second press would report "Still sending
        // Still sending Unlock…".
        setState(state, runningCommand ? 'Still sending ' + runningCommand + '…' : 'Still working…')
        return
      }
      setState(STATE.ERROR, 'Not connected')
      return
    }

    runningCommand = name
    setState(STATE.BUSY, name)
    invoke(buildClient(), (err) => {
      runningCommand = null
      if (err) {
        setState(STATE.ERROR, err.message)
        // An unenrolled key is a setup problem, not a transient one.
        if (err.message.indexOf('not enrolled') >= 0) {
          storage.setEnrolled(false)
          setState(STATE.NEEDS_ENROLMENT, 'Add this key to your car')
        }
        return
      }
      // "Sent" and not "done": VCSEC acknowledges by staying silent, which
      // proves the message was accepted, not that anything moved. The status
      // read that follows is what can actually confirm it.
      setState(STATE.READY, name + ' sent')
      refreshStatus()
    })
  }

  function connect () {
    const vin = storage.getVin()
    if (!vin) {
      setState(STATE.NEEDS_VIN, 'Pair your car from the settings page on your phone.')
      return
    }

    const link = ensureTransport()
    // The advertised name is derived from the VIN, so this picks out one
    // specific car without ever storing its address. Unless this build was made
    // to look for something else, which is only ever a test rig -- said out
    // loud, because a build carrying an override cannot find a real car and
    // there is nothing on screen to distinguish that from a car out of range.
    const override = localNameOverride(bleNameOverride)
    if (override) {
      log('scanning for ' + override + ' from freesla.config.js, not the name this VIN derives')
    }
    connectStartedAt = Date.now()
    link.connect(expectedLocalName(vin, bleNameOverride))
  }

  // Puts the enrolment request on the wire. Only ever called with the link up,
  // either straight from the owner's tap or once a pending one connects.
  function sendEnrolment () {
    setState(STATE.ENROLLING, 'Tap your keycard on the console')
    buildClient().requestEnrolment(ROLE.DRIVER, KEY_FORM_FACTOR.ANDROID_DEVICE)
  }

  // Probes whether enrolment completed by attempting a handshake; the vehicle
  // reports an unknown key rather than silently ignoring it. Requires the link.
  function runEnrolmentCheck () {
    setState(STATE.BUSY, 'Checking')

    buildClient().unlock((err) => {
      if (err) {
        setState(STATE.NEEDS_ENROLMENT, err.message.indexOf('not enrolled') >= 0
          ? 'Not added yet, tap your keycard'
          : err.message)
        return
      }
      storage.setEnrolled(true)
      setState(STATE.READY, 'Key added')
    })
  }

  // Asks the car what is open. Sent as a signed command like any other, so a
  // reply that decrypts is trustworthy in a way a broadcast never is.
  function refreshStatus () {
    if (!keys || state !== STATE.READY) return
    buildClient().requestVehicleStatus((err) => {
      if (err) log('status request failed: ' + err.message)
    })
  }

  return {
    get state () { return state },
    get detail () { return detail },

    begin () {
      refresh()
    },

    // Installs a keypair built on the phone, which is the only way a key gets
    // onto this watch. Instant: the expensive half already happened elsewhere.
    installKeyPair (privateKey, publicKey) {
      let result
      try {
        result = identity.installKeyPair(privateKey, publicKey)
      } catch (e) {
        setState(STATE.NEEDS_KEY, e.message + ' Tap to try again.')
        return null
      }

      keys = { privateKey: result.privateKey, publicKey: result.publicKey }
      // The client captured the previous key when it was built, including which
      // namespace of the session-key cache to read. Left in place it would go
      // on signing with the old key and reading the old key's cached secrets.
      discardClient()
      log('installed a keypair generated on the phone')
      refresh()
      return result
    },

    // Reports that the phone could not supply a key. There is no watch-side
    // fallback on purpose: the two things it would need -- a secure generator
    // and a scalar multiplication -- are the two things this platform is worst
    // at, and a key made without the first is worse than no key at all.
    keyUnavailable (reason) {
      setState(STATE.NEEDS_KEY, reason)
    },

    setVin (vin) {
      storage.setVin(vin)
      pendingEnrolmentStep = null
      // A different VIN is a different car, so the link to the old one has to
      // go. The transport refuses connect() in any state but IDLE or FAILED, so
      // leaving it up would make every attempt to reach the new car a no-op
      // while the screen said "Looking for your car".
      if (transport) transport.close()
      discardClient()
      refresh()
    },

    connect,

    // What the previous run was doing when it stopped, or null. Read once.
    lastConnectStep () { return breadcrumb.take() },

    // Closing the app deliberately is not a crash, so the trail goes with it;
    // otherwise every ordinary exit mid-connection would be reported as one.
    forgetConnectStep () { breadcrumb.clear() },

    disconnect () {
      pendingEnrolmentStep = null
      breadcrumb.clear()
      if (transport) transport.close()
      discardClient()
      // Any command that was in flight has just been abandoned, so leaving the
      // screen on "Unlock" would claim something is still happening. Nothing is
      // waiting to correct it any more -- its timeout went with the client.
      if (state === STATE.BUSY || state === STATE.ENROLLING) {
        setState(STATE.DISCONNECTED, 'Disconnected')
      }
    },

    // Asks the vehicle to enrol this key. The vehicle then waits for the owner
    // to tap an existing NFC keycard on the centre console -- nothing the watch
    // sends can stand in for that.
    //
    // This is the whole of pairing from the wearer's side, so it connects on
    // its own when the car is not linked yet. Requiring a separate Connect tap
    // first left the one screen that starts setup with no way out of it.
    requestEnrolment () {
      if (!keys) {
        refresh()
        return
      }
      if (transport && transport.state === BLE_STATE.READY) {
        sendEnrolment()
        return
      }

      pendingEnrolmentStep = 'request'
      connect()
    },

    // Called once the vehicle accepts a command, which proves enrolment worked.
    confirmEnrolment () {
      storage.setEnrolled(true)
      setState(STATE.READY, 'Key added')
    },

    // Confirms the keycard tap worked. Reconnects first if the car dropped out
    // during enrolment, rather than leaving the button doing nothing at all.
    checkEnrolment () {
      if (!keys) {
        refresh()
        return
      }
      if (transport && transport.state === BLE_STATE.READY) {
        runEnrolmentCheck()
        return
      }

      pendingEnrolmentStep = 'check'
      connect()
    },

    setAutoUnlock (enabled) {
      storage.setAutoUnlock(enabled)
      // Turning it on beside an already-connected car should take effect now.
      if (enabled) maybeAutoUnlock()
    },

    autoUnlockEnabled () { return storage.autoUnlockEnabled() },

    unlock () { runCommand('Unlock', (c, cb) => c.unlock(cb)) },
    lock () { runCommand('Lock', (c, cb) => c.lock(cb)) },

    // Closures. What a given car does with these depends on what it has
    // powered: doors only swing on a Model X and merely unlatch elsewhere, and
    // the frunk latch releases but nothing can pull it shut again. A car
    // silently ignores what it cannot do, so "sent" never means "moved".
    openDoors () { runCommand('Doors', (c, cb) => c.openDoors(cb)) },
    openTrunk () { runCommand('Trunk open', (c, cb) => c.openTrunk(cb)) },
    closeTrunk () { runCommand('Trunk close', (c, cb) => c.closeTrunk(cb)) },
    stopTrunk () { runCommand('Stop', (c, cb) => c.stopTrunk(cb)) },
    openFrunk () { runCommand('Frunk', (c, cb) => c.openFrunk(cb)) },
    openChargePort () { runCommand('Charge port', (c, cb) => c.openChargePort(cb)) },
    closeChargePort () { runCommand('Charge port', (c, cb) => c.closeChargePort(cb)) },

    // Named lookup so the controls screen can stay data-driven.
    run (action) {
      if (typeof this[action] === 'function') this[action]()
    },

    // Last reported closure and lock state, or null before anything has arrived.
    // Always read alongside statusTrust: an overheard broadcast is unauthenticated.
    get vehicleStatus () { return vehicleStatus },
    get statusTrust () { return statusTrust },

    closureState (closureField) {
      if (!vehicleStatus) return undefined
      return vehicleStatus.closures[closureField]
    },

    refreshStatus,

    observeForEntropy (bytes) { identity.observe(bytes) }
  }
}
