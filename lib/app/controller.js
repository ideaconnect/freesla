// Application controller: the state machine the UI renders.
//
// Keeps the page free of protocol detail. Everything is callback-driven --
// async/await is unsupported on this runtime and hangs the app rather than
// failing loudly.

import { STATE as BLE_STATE } from '../zepp/ble-states.js'
import { createClient } from '../tesla/client.js'
import { createNonceSource } from '../tesla/nonce.js'
import { vehicleLocalName } from '../tesla/messages.js'
import { SERVICE_UUID, WRITE_UUID, NOTIFY_UUID, ROLE, KEY_FORM_FACTOR } from '../tesla/constants.js'
import { createIdentity } from './identity.js'
import { createDrbg, collectWatchEntropy } from '../crypto/random.js'

export const STATE = {
  NEEDS_VIN: 'needs-vin',
  NEEDS_KEY: 'needs-key',
  GENERATING_KEY: 'generating-key',
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

  function setState (next, message) {
    state = next
    detail = message || ''
    log('state ' + next + (message ? ': ' + message : ''))
    onChange(state, detail)
  }

  function ensureRandom () {
    if (!randomBytes) randomBytes = createDrbg(collectWatchEntropy(null))
    return randomBytes
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
      sessionKeyCache: storage.asSessionKeyCache(),
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
        if (bleState === BLE_STATE.FAILED) setState(STATE.ERROR, bleDetail || 'connection failed')
        else if (bleState === BLE_STATE.SCANNING) setState(STATE.CONNECTING, 'Looking for your car')
        else if (bleState === BLE_STATE.CONNECTING) setState(STATE.CONNECTING, 'Connecting')
        else if (bleState === BLE_STATE.READY) {
          // Connecting says nothing about whether we hold a usable key, so the
          // blocker is re-derived rather than assumed away.
          if (!keys) {
            refresh()
          } else {
            setState(storage.isEnrolled() ? STATE.READY : STATE.NEEDS_ENROLMENT,
              storage.isEnrolled() ? 'Connected' : 'Tap to add this key')
            maybeAutoUnlock()
          }
        } else if (bleState === BLE_STATE.IDLE && bleDetail === 'disconnected') {
          autoUnlockArmed = true
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
      setState(STATE.READY, 'Connected — move closer')
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
      setState(STATE.ERROR, 'Not connected')
      return
    }

    setState(STATE.BUSY, name)
    invoke(buildClient(), (err) => {
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

    // Blocking and slow. The caller must paint the progress state and yield to
    // the runtime before calling, or the screen will not update.
    //
    // `externalEntropy` should be the phone's CSPRNG output when it could be
    // obtained; the watch alone has no strong source.
    generateKey (externalEntropy) {
      let result
      try {
        result = identity.generate(externalEntropy)
      } catch (e) {
        setState(STATE.NEEDS_KEY,
          'Your phone did not answer. This watch has no secure random source of ' +
          'its own, so the key cannot be made without it. Open the Zepp app on ' +
          'your phone, then tap Create key again.')
        return null
      }

      keys = { privateKey: result.privateKey, publicKey: result.publicKey }
      log('key generated with phone randomness (scan observations: ' +
        result.observationCount + ')')
      refresh()
      return result
    },

    setVin (vin) {
      storage.setVin(vin)
      client = null
      refresh()
    },

    connect () {
      const vin = storage.getVin()
      if (!vin) {
        setState(STATE.NEEDS_VIN, 'Pair your car from the settings page on your phone.')
        return
      }

      const link = ensureTransport()
      // The advertised name is derived from the VIN, so this picks out one
      // specific car without ever storing its address.
      link.connect(vehicleLocalName(vin))
    },

    disconnect () {
      if (transport) transport.close()
      client = null
    },

    // Asks the vehicle to enrol this key. The vehicle then waits for the owner
    // to tap an existing NFC keycard on the centre console -- nothing the watch
    // sends can stand in for that.
    requestEnrolment () {
      if (!transport || transport.state !== BLE_STATE.READY) {
        setState(STATE.ERROR, 'Connect to your car first')
        return
      }

      setState(STATE.ENROLLING, 'Tap your keycard on the console')
      buildClient().requestEnrolment(ROLE.DRIVER, KEY_FORM_FACTOR.ANDROID_DEVICE)
    },

    // Called once the vehicle accepts a command, which proves enrolment worked.
    confirmEnrolment () {
      storage.setEnrolled(true)
      setState(STATE.READY, 'Key added')
    },

    // Probes whether enrolment completed by attempting a handshake; the vehicle
    // reports an unknown key rather than silently ignoring it.
    checkEnrolment () {
      if (!transport || transport.state !== BLE_STATE.READY) return
      setState(STATE.BUSY, 'Checking')

      buildClient().unlock((err) => {
        if (err) {
          setState(STATE.NEEDS_ENROLMENT, err.message.indexOf('not enrolled') >= 0
            ? 'Not added yet — tap your keycard'
            : err.message)
          return
        }
        storage.setEnrolled(true)
        setState(STATE.READY, 'Key added')
      })
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
