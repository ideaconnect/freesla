// A stand-in for the BLE transport that drives the same state callbacks the
// real one does, backed by the mock vehicle. Lets the controller's auto-unlock
// decisions be tested off-device, which matters because they open a car with no
// user action.

import { STATE } from '../lib/zepp/ble-states.js'

export function createFakeTransportFactory (vehicle, settings) {
  const config = settings || {}
  let current = null

  const factory = function (options) {
    const onState = options.onState || function () {}
    const onObservation = options.onObservation || function () {}

    let state = STATE.IDLE
    let messageHandler = null

    vehicle.link.onMessage((message) => {
      if (messageHandler) messageHandler(message)
    })

    function moveTo (next, detail) {
      state = next
      onState(next, detail)
    }

    // The name the controller last asked to be found. The real transport scans
    // for exactly this and ignores everything else, so it is the whole of
    // whether the right car is reachable -- worth being able to assert on.
    let deviceName = null

    current = {
      get state () { return state },
      get rssi () { return config.rssi === undefined ? -50 : config.rssi },
      get deviceName () { return deviceName },

      connect (name) {
        deviceName = name
        moveTo(STATE.SCANNING, 'Looking for your car')
        // A scan turns up other advertisements too; they are offered as entropy.
        onObservation(new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]))

        if (config.neverFinds) return
        setTimeout(() => moveTo(STATE.READY), 2)
      },

      send (message) { vehicle.link.send(message) },
      onMessage (handler) { messageHandler = handler },
      close () { moveTo(STATE.IDLE, 'closed') },

      // Models the car passing out of range.
      simulateDisconnect () { moveTo(STATE.IDLE, 'disconnected') },

      // Models a scan that ran its course without finding anything -- the
      // failure a wrong name produces, and the one a car parked elsewhere
      // produces too.
      simulateScanFailure (detail) {
        moveTo(STATE.FAILED, detail || 'Car not found. Stand next to it and try again.')
      }
    }
    return current
  }

  factory.current = () => current
  factory.setRssi = (value) => { config.rssi = value }
  return factory
}
