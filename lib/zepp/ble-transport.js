// Zepp OS BLE transport: finds the vehicle, opens a GATT link, and presents it
// as the same { send, onMessage, close } interface the mock vehicle speaks, so
// the protocol client above is identical on the watch and under test.
//
// The connection sequence Zepp OS requires is: scan for the advertised name,
// connect to get a connection id, declare the GATT layout with mstBuildProfile,
// resolve it to a profile handle, run mstPrepare to discover it on the peer,
// then enable notifications by writing the CCCD.

import {
  mstStartScan, mstStopScan, mstConnect, mstDisconnect,
  mstBuildProfile, mstGetProfileInstance, mstPrepare, mstOnPrepare,
  mstOnCharaNotification, mstWriteCharacteristic, mstWriteDescriptor,
  mstOffAllCb, mstDestroyProfileInstance
} from '@zos/ble'

import { frameMessage, createReassembler } from '../tesla/framing.js'
import { STATE } from './ble-states.js'

// Assigned by the Bluetooth SIG for client characteristic configuration.
const CCCD_UUID = '00002902-0000-1000-8000-00805f9b34fb'
const ENABLE_NOTIFICATIONS = new Uint8Array([0x01, 0x00])

// Conservative: 23-byte default MTU leaves 20 bytes of payload per write. The
// Zepp API exposes no MTU negotiation, so assuming more risks silent truncation.
const DEFAULT_CHUNK_SIZE = 20

const PROFILE_NAME = 'freesla'

export { STATE } from './ble-states.js'

export function createBleTransport (options) {
  const serviceUuid = options.serviceUuid
  const writeUuid = options.writeUuid
  const notifyUuid = options.notifyUuid
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE
  const log = options.log || function () {}

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

  function setState (next, detail) {
    state = next
    log('ble state -> ' + next + (detail ? ' (' + detail + ')' : ''))
    stateHandler(next, detail)
  }

  function fail (reason) {
    setState(STATE.FAILED, reason)
  }

  // The published typings declare positional callback arguments, but the
  // runtime passes a single object. Zepp's own easy-ble library confirms the
  // object form; following the typings here yields undefined for every field.
  function handleNotification (event) {
    const uuid = event.uuid
    const data = event.data
    const length = event.length
    if (!uuid || uuid.toLowerCase() !== notifyUuid.toLowerCase()) return

    // The ArrayBuffer belongs to the native layer and may be reused, so the
    // bytes are copied out before they reach the reassembler.
    const view = new Uint8Array(data, 0, length === undefined ? undefined : length)
    const chunk = new Uint8Array(view.length)
    chunk.set(view)

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
  }

  function buildProfile () {
    const ok = mstBuildProfile({
      pair: false,
      id: connectId,
      profile: PROFILE_NAME,
      dev: deviceAddress,
      len: 1,
      list: [{
        len: 1,
        list: [{
          uuid: serviceUuid,
          permission: 0,
          len1: 2,
          list: [
            { uuid: writeUuid, permission: 0, len: 0, list: [] },
            { uuid: notifyUuid, permission: 0, len: 1, list: [{ uuid: CCCD_UUID, permission: 0 }] }
          ]
        }]
      }]
    })

    if (!ok) {
      fail('could not build the GATT profile')
      return false
    }

    profile = mstGetProfileInstance(PROFILE_NAME, connectId)
    if (profile === undefined || profile === null) {
      fail('could not resolve the profile instance')
      return false
    }
    return true
  }

  function onPrepared (event) {
    const status = event.status
    if (status !== 0) {
      fail('profile preparation failed with status ' + status)
      return
    }
    // The profile pointer only becomes available once preparation succeeds.
    if (profile === null || profile === undefined) profile = event.profile

    mstOnCharaNotification(handleNotification)
    mstWriteDescriptor(profile, notifyUuid, CCCD_UUID, ENABLE_NOTIFICATIONS.buffer, 2)
    setState(STATE.READY)
  }

  function onConnectResult (result) {
    if (result.connected === 2) {
      // The vehicle dropped us — expected on walk-away.
      reassembler.reset()
      profile = null
      connectId = null
      setState(STATE.IDLE, 'disconnected')
      return
    }
    if (result.connected !== 0) {
      fail('connection refused')
      return
    }

    connectId = result.connect_id
    setState(STATE.PREPARING)

    // Ordering matters and is not obvious: the prepare callback has to be
    // registered before the profile is built, and the stack needs a moment
    // between the two or the callback silently never fires.
    mstOnPrepare(onPrepared)
    setTimeout(() => {
      if (!buildProfile()) return
      mstPrepare(profile)
    }, 50)
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

      reassembler.reset()
      setState(STATE.SCANNING, deviceName)

      let settled = false
      const started = mstStartScan((result) => {
        if (settled) return

        // Fold every advertisement into the entropy pool, not just our car's.
        try {
          const observed = new Uint8Array(8)
          const addr = new Uint8Array(result.dev_addr, 0, 6)
          observed.set(addr)
          observed[6] = result.rssi & 0xff
          observed[7] = (Date.now() & 0xff)
          observationHandler(observed)
        } catch (e) {
          // Never let entropy collection break a connection attempt.
        }

        if (result.dev_name !== deviceName) return

        settled = true
        lastRssi = result.rssi
        mstStopScan()

        // Copy the address: the scan result's buffer is not ours to keep.
        const addr = new Uint8Array(6)
        addr.set(new Uint8Array(result.dev_addr, 0, 6))
        deviceAddress = addr.buffer

        setState(STATE.CONNECTING, 'rssi ' + result.rssi)
        if (!mstConnect(deviceAddress, onConnectResult)) {
          fail('connect call rejected')
        }
      }, { device_name: deviceName })

      if (!started) {
        fail('could not start scanning')
        return false
      }
      return true
    },

    // Writes one protocol message, fragmented to fit the MTU.
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
        mstWriteCharacteristic(profile, writeUuid, owned.buffer, owned.length)
      }
      return true
    },

    close () {
      try {
        if (state === STATE.SCANNING) mstStopScan()
        mstOffAllCb()
        if (profile !== null && profile !== undefined) mstDestroyProfileInstance(profile)
        if (connectId !== null) mstDisconnect(connectId)
      } catch (e) {
        log('close error: ' + e.message)
      }
      profile = null
      connectId = null
      reassembler.reset()
      setState(STATE.IDLE, 'closed')
    }
  }
}
