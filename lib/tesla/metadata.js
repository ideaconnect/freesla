// Signature metadata: the authenticated context that binds a command to one
// vehicle, one session, and one moment in time.
//
// Encoding is a flat TLV run (one tag byte, one length byte, the value)
// emitted in ascending tag order and closed with 0xFF. The signed or encrypted
// payload is then folded into the *same* hash, which is why this exposes
// checksum/hmac helpers rather than just returning bytes.
//
// An absent value is skipped entirely rather than written as a zero-length
// entry; the vehicle computes the same omission, so emitting an empty TLV would
// desynchronise the two hashes.

import { sha256, hmacSha256 } from '../crypto/sha256.js'
import { utf8Encode } from './protobuf.js'
import { TAG } from './constants.js'

export function createMetadata () {
  return { bytes: [], lastTag: -1 }
}

export function addField (meta, tag, value) {
  if (value === undefined || value === null) return meta
  if (tag < meta.lastTag) throw new Error('metadata: tag ' + tag + ' out of order')
  if (value.length > 255) throw new Error('metadata: field ' + tag + ' too long')

  meta.lastTag = tag
  meta.bytes.push(tag, value.length)
  for (let i = 0; i < value.length; i++) meta.bytes.push(value[i])
  return meta
}

export function addByte (meta, tag, value) {
  return addField(meta, tag, [value])
}

export function addUint32 (meta, tag, value) {
  return addField(meta, tag, [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  ])
}

export function addString (meta, tag, text) {
  return addField(meta, tag, utf8Encode(text))
}

// Closes the run with the terminator and appends `message`, yielding the exact
// byte string that gets hashed.
export function finish (meta, message) {
  const extra = message ? message.length : 0
  const out = new Uint8Array(meta.bytes.length + 1 + extra)
  for (let i = 0; i < meta.bytes.length; i++) out[i] = meta.bytes[i]
  out[meta.bytes.length] = TAG.END
  if (message) out.set(message, meta.bytes.length + 1)
  return out
}

// SHA-256 over the metadata. This digest, not the metadata itself, is what
// AES-GCM takes as additional authenticated data.
export function checksum (meta, message) {
  return sha256(finish(meta, message))
}

export function hmac (key, meta, message) {
  return hmacSha256(key, finish(meta, message))
}
