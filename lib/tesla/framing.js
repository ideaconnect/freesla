// Message framing for the vehicle's GATT link.
//
// The characteristic is a byte stream, not a message queue: a BLE notification
// carries at most (MTU - 3) bytes, so one protocol message spans several
// notifications and two short messages can share one. Each message is therefore
// prefixed with its big-endian 16-bit length, and the receiver reassembles.

export const MAX_MESSAGE_SIZE = 1024

// Splits a message into writes that fit the negotiated MTU, prepending the
// two-byte length header.
export function frameMessage (message, chunkSize) {
  if (message.length > MAX_MESSAGE_SIZE) {
    throw new Error('framing: message of ' + message.length + ' bytes exceeds the protocol limit')
  }

  const framed = new Uint8Array(message.length + 2)
  framed[0] = (message.length >>> 8) & 0xff
  framed[1] = message.length & 0xff
  framed.set(message, 2)

  if (!chunkSize || chunkSize >= framed.length) return [framed]

  const chunks = []
  for (let off = 0; off < framed.length; off += chunkSize) {
    chunks.push(framed.subarray(off, Math.min(off + chunkSize, framed.length)))
  }
  return chunks
}

// Accumulates inbound bytes and yields whole messages.
//
// The vehicle is not obliged to respect our framing if something desynchronises,
// so an implausible length is treated as a hard error rather than a reason to
// wait for a gigantic message that will never arrive.
export function createReassembler () {
  let buffer = new Uint8Array(0)

  return {
    // Returns an array of complete messages, possibly empty.
    push (chunk) {
      const merged = new Uint8Array(buffer.length + chunk.length)
      merged.set(buffer)
      merged.set(chunk, buffer.length)
      buffer = merged

      const messages = []
      for (;;) {
        if (buffer.length < 2) break

        const expected = (buffer[0] << 8) | buffer[1]
        if (expected > MAX_MESSAGE_SIZE) {
          buffer = new Uint8Array(0)
          throw new Error('framing: declared length ' + expected + ' is out of range')
        }
        if (buffer.length < expected + 2) break

        messages.push(buffer.slice(2, expected + 2))
        buffer = buffer.slice(expected + 2)
      }
      return messages
    },

    reset () {
      buffer = new Uint8Array(0)
    },

    get pending () {
      return buffer.length
    }
  }
}
