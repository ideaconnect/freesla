// A simulated BLE link.
//
// The mock vehicle exchanges whole messages, but a real GATT connection does
// not: it carries ~20-byte writes and notifications, and the protocol's length
// prefix is what puts messages back together. Routing the test traffic through
// the same framing code the watch uses means fragmentation bugs surface here
// rather than in a car park.

import { frameMessage, createReassembler } from '../lib/tesla/framing.js'

const DEFAULT_MTU_PAYLOAD = 20

export function createSimulatedBleLink (vehicleLink, options) {
  const settings = options || {}
  const chunkSize = settings.chunkSize || DEFAULT_MTU_PAYLOAD
  const onTraffic = settings.onTraffic || function () {}

  let clientHandler = null

  const toVehicle = createReassembler()
  const toClient = createReassembler()

  // Everything the vehicle emits arrives at the client as a run of
  // notifications, delivered one at a time on separate ticks.
  vehicleLink.onMessage((message) => {
    const chunks = frameMessage(message, chunkSize)
    onTraffic({ direction: 'rx', message, chunks: chunks.length })

    for (const chunk of chunks) {
      const copy = new Uint8Array(chunk)
      setImmediate(() => {
        let assembled
        try {
          assembled = toClient.push(copy)
        } catch (e) {
          return
        }
        for (const complete of assembled) {
          if (clientHandler) clientHandler(complete)
        }
      })
    }
  })

  return {
    send (message) {
      const chunks = frameMessage(message, chunkSize)
      onTraffic({ direction: 'tx', message, chunks: chunks.length })

      for (const chunk of chunks) {
        const copy = new Uint8Array(chunk)
        setImmediate(() => {
          let assembled
          try {
            assembled = toVehicle.push(copy)
          } catch (e) {
            return
          }
          for (const complete of assembled) vehicleLink.send(complete)
        })
      }
    },

    onMessage (handler) {
      clientHandler = handler
    }
  }
}
