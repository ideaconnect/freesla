// Session cryptography: turning an ECDH exchange into authenticated commands.
//
// The chain is
//
//     K   = SHA1(ECDH_x)[0:16]                        AES-128 session key
//     K'  = HMAC-SHA256(K, "authenticated command")   command subkey
//     Ks  = HMAC-SHA256(K, "session info")            handshake subkey
//
// SHA-1 here is not a security claim; it maps a pseudorandom curve point onto a
// pseudorandom bit string, and Tesla fixed the choice long ago.
//
// K depends only on our private key and the vehicle's public key, so it is
// stable for the life of both. That is what keeps this practical on a watch:
// the expensive elliptic-curve work happens once and is cached, and every
// unlock afterwards costs one AES-GCM encryption.

import { sha1 } from '../crypto/sha1.js'
import { hmacSha256 } from '../crypto/sha256.js'
import { gcmEncrypt, gcmDecrypt } from '../crypto/gcm.js'
import { ecdh } from '../crypto/p256.js'
import { utf8Encode } from './protobuf.js'
import { createMetadata, addByte, addUint32, addString, addField, checksum } from './metadata.js'
import {
  TAG, SIGNATURE_TYPE, LABEL_SESSION_INFO, LABEL_MESSAGE_AUTH
} from './constants.js'

export function deriveSessionKey (privateKey, vehiclePublicKey) {
  const sharedX = ecdh(privateKey, vehiclePublicKey)
  if (!sharedX) return null
  return sha1(sharedX).subarray(0, 16)
}

export function deriveSubkey (sessionKey, label) {
  return hmacSha256(sessionKey, utf8Encode(label))
}

// Authenticates a handshake reply.
//
// `rawSessionInfo` must be the bytes exactly as received: the vehicle signed
// its own serialization, and re-encoding the parsed fields can reorder them
// into a different byte string that fails to verify.
//
// VCSEC often omits request_uuid to save memory, in which case the challenge
// TLV is left out on both sides.
export function sessionInfoTag (sessionKey, vin, challenge, rawSessionInfo) {
  const meta = createMetadata()
  addByte(meta, TAG.SIGNATURE_TYPE, SIGNATURE_TYPE.HMAC)
  addString(meta, TAG.PERSONALIZATION, vin)
  if (challenge && challenge.length > 0) addField(meta, TAG.CHALLENGE, challenge)

  const key = deriveSubkey(sessionKey, LABEL_SESSION_INFO)
  return hmacSha256(key, concatBytes(finishMeta(meta), rawSessionInfo))
}

export function verifySessionInfo (sessionKey, vin, challenge, rawSessionInfo, tag) {
  if (!tag || tag.length !== 32) return false
  const expected = sessionInfoTag(sessionKey, vin, challenge, rawSessionInfo)

  let diff = 0
  for (let i = 0; i < 32; i++) diff |= expected[i] ^ tag[i]
  return diff === 0
}

// Metadata accompanying an outbound command. Flags are only included when
// non-zero, matching the vehicle's own backwards-compatible construction; a
// man-in-the-middle clearing them therefore breaks the hash, as intended.
export function commandMetadata (params) {
  const meta = createMetadata()
  addByte(meta, TAG.SIGNATURE_TYPE, SIGNATURE_TYPE.AES_GCM_PERSONALIZED)
  addByte(meta, TAG.DOMAIN, params.domain)
  addString(meta, TAG.PERSONALIZATION, params.vin)
  addField(meta, TAG.EPOCH, params.epoch)
  addUint32(meta, TAG.EXPIRES_AT, params.expiresAt)
  addUint32(meta, TAG.COUNTER, params.counter)
  if (params.flags > 0) addUint32(meta, TAG.FLAGS, params.flags)
  return meta
}

export function encryptCommand (params) {
  const aad = checksum(commandMetadata(params))
  const result = gcmEncrypt(params.sessionKey, params.nonce, params.plaintext, aad, 16)
  return { ciphertext: result.ciphertext, tag: result.tag, nonce: params.nonce }
}

// Identifies which request a response belongs to: the signature type byte
// followed by the request's authentication tag, truncated to 16 bytes.
export function requestHash (signatureType, tag) {
  const out = new Uint8Array(1 + Math.min(16, tag.length))
  out[0] = signatureType
  for (let i = 0; i < out.length - 1; i++) out[i + 1] = tag[i]
  return out
}

// Responses always carry their flags, even when zero -- unlike requests.
export function responseMetadata (params) {
  const meta = createMetadata()
  addByte(meta, TAG.SIGNATURE_TYPE, SIGNATURE_TYPE.AES_GCM_RESPONSE)
  addByte(meta, TAG.DOMAIN, params.domain)
  addString(meta, TAG.PERSONALIZATION, params.vin)
  addUint32(meta, TAG.COUNTER, params.counter)
  addUint32(meta, TAG.FLAGS, params.flags || 0)
  addField(meta, TAG.REQUEST_HASH, params.requestHash)
  addUint32(meta, TAG.FAULT, params.fault || 0)
  return meta
}

export function encryptResponse (params) {
  const aad = checksum(responseMetadata(params))
  return gcmEncrypt(params.sessionKey, params.nonce, params.plaintext, aad, 16)
}

// Returns the plaintext, or null when authentication fails.
export function decryptResponse (params) {
  const aad = checksum(responseMetadata(params))
  return gcmDecrypt(params.sessionKey, params.nonce, params.ciphertext, aad, params.tag)
}

export function commandSubkey (sessionKey) {
  return deriveSubkey(sessionKey, LABEL_MESSAGE_AUTH)
}

function finishMeta (meta) {
  const out = new Uint8Array(meta.bytes.length + 1)
  for (let i = 0; i < meta.bytes.length; i++) out[i] = meta.bytes[i]
  out[meta.bytes.length] = TAG.END
  return out
}

function concatBytes (a, b) {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

// Tracks anti-replay state for one domain.
//
// The counter is incremented before use, so the first command after a handshake
// carries session_info.counter + 1. On resync the counter never moves backwards
// within an epoch -- doing so would let a replayed session_info reopen a window
// the vehicle has already closed.
export function createSessionState () {
  return {
    established: false,
    sessionKey: null,
    epoch: null,
    counter: 0,
    timeZero: 0,
    vehiclePublicKey: null
  }
}

export function applySessionInfo (state, info, sessionKey, nowSeconds) {
  const epochChanged = !state.epoch || !bytesEqual(state.epoch, info.epoch)

  state.sessionKey = sessionKey
  state.vehiclePublicKey = info.publicKey
  state.epoch = info.epoch
  state.timeZero = nowSeconds - info.clockTime

  if (epochChanged || info.counter > state.counter) state.counter = info.counter
  state.established = true
  return state
}

export function nextCounter (state) {
  state.counter = state.counter + 1
  if (state.counter > 4294967295) throw new Error('session: counter exhausted')
  return state.counter
}

// Expiry is expressed on the vehicle's clock, which is why timeZero is tracked.
export function expiresAt (state, nowSeconds, lifetimeSeconds) {
  return Math.floor(nowSeconds + lifetimeSeconds - state.timeZero)
}

function bytesEqual (a, b) {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
