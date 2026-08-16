// Construction and parsing of the messages exchanged with the vehicle.

import { sha1 } from '../crypto/sha1.js'
import {
  createWriter, writeVarintField, writeBytesField, writeFixed32Field,
  writeMessageField, finishWriter, decode, first, firstMessage, utf8Encode
} from './protobuf.js'
import {
  ROUTABLE, DESTINATION, SESSION_INFO_REQUEST, SESSION_INFO, SIGNATURE_DATA,
  KEY_IDENTITY, AES_GCM_PERSONALIZED, AES_GCM_RESPONSE, HMAC_SIGNATURE_DATA,
  MESSAGE_STATUS, UNSIGNED_MESSAGE, CLOSURE_FIELD, CLOSURE_MOVE, WHITELIST_OPERATION,
  PERMISSION_CHANGE, PUBLIC_KEY_FIELD, KEY_METADATA, TO_VCSEC_MESSAGE,
  VCSEC_SIGNED_MESSAGE, VCSEC_SIGNATURE_TYPE, FROM_VCSEC_MESSAGE,
  COMMAND_STATUS, MESSAGE_FAULT_NAMES, GENERIC_ERROR_MESSAGES,
  VEHICLE_STATUS, CLOSURE_STATE_NAMES, VEHICLE_LOCK_STATE_NAMES
} from './constants.js'

const HEX = '0123456789abcdef'

// The vehicle advertises S<16 lowercase hex>C, where the hex is the first eight
// bytes of SHA-1 over the VIN. Scanning for this name is how one specific car is
// picked out without ever storing its MAC address.
export function vehicleLocalName (vin) {
  const digest = sha1(utf8Encode(vin))
  let name = 'S'
  for (let i = 0; i < 8; i++) {
    name += HEX[(digest[i] >>> 4) & 0x0f] + HEX[digest[i] & 0x0f]
  }
  return name + 'C'
}

function destination (writer, field, options) {
  const dest = createWriter()
  if (options.domain !== undefined) writeVarintField(dest, DESTINATION.DOMAIN, options.domain)
  if (options.routingAddress) writeBytesField(dest, DESTINATION.ROUTING_ADDRESS, options.routingAddress)
  return writeMessageField(writer, field, dest)
}

// Opens a session: hands the vehicle our public key and a random uuid that
// doubles as the anti-replay challenge it must echo back.
export function buildSessionInfoRequest (params) {
  const request = createWriter()
  writeBytesField(request, SESSION_INFO_REQUEST.PUBLIC_KEY, params.publicKey)

  const message = createWriter()
  destination(message, ROUTABLE.TO_DESTINATION, { domain: params.domain })
  destination(message, ROUTABLE.FROM_DESTINATION, { routingAddress: params.routingAddress })
  writeMessageField(message, ROUTABLE.SESSION_INFO_REQUEST, request)
  writeBytesField(message, ROUTABLE.UUID, params.uuid)
  return finishWriter(message)
}

export function buildSignedCommand (params) {
  const gcm = createWriter()
  writeBytesField(gcm, AES_GCM_PERSONALIZED.EPOCH, params.epoch)
  writeBytesField(gcm, AES_GCM_PERSONALIZED.NONCE, params.nonce)
  writeVarintField(gcm, AES_GCM_PERSONALIZED.COUNTER, params.counter)
  writeFixed32Field(gcm, AES_GCM_PERSONALIZED.EXPIRES_AT, params.expiresAt)
  writeBytesField(gcm, AES_GCM_PERSONALIZED.TAG, params.tag)

  const identity = createWriter()
  writeBytesField(identity, KEY_IDENTITY.PUBLIC_KEY, params.publicKey)

  const signature = createWriter()
  writeMessageField(signature, SIGNATURE_DATA.SIGNER_IDENTITY, identity)
  writeMessageField(signature, SIGNATURE_DATA.AES_GCM_PERSONALIZED, gcm)

  const message = createWriter()
  destination(message, ROUTABLE.TO_DESTINATION, { domain: params.domain })
  destination(message, ROUTABLE.FROM_DESTINATION, { routingAddress: params.routingAddress })
  writeBytesField(message, ROUTABLE.PROTOBUF_MESSAGE_AS_BYTES, params.ciphertext)
  writeMessageField(message, ROUTABLE.SIGNATURE_DATA, signature)
  writeBytesField(message, ROUTABLE.UUID, params.uuid)
  writeVarintField(message, ROUTABLE.FLAGS, params.flags)
  return finishWriter(message)
}

function parseDestination (fields) {
  if (!fields) return null
  return {
    domain: first(fields, DESTINATION.DOMAIN),
    routingAddress: first(fields, DESTINATION.ROUTING_ADDRESS)
  }
}

export function parseRoutableMessage (bytes) {
  const fields = decode(bytes)

  const status = firstMessage(fields, ROUTABLE.SIGNED_MESSAGE_STATUS)
  const signature = firstMessage(fields, ROUTABLE.SIGNATURE_DATA)

  let responseSignature = null
  if (signature) {
    const response = firstMessage(signature, SIGNATURE_DATA.AES_GCM_RESPONSE)
    if (response) {
      responseSignature = {
        nonce: first(response, AES_GCM_RESPONSE.NONCE),
        counter: first(response, AES_GCM_RESPONSE.COUNTER) || 0,
        tag: first(response, AES_GCM_RESPONSE.TAG)
      }
    }
  }

  let sessionInfoTag = null
  if (signature) {
    const hmacData = firstMessage(signature, SIGNATURE_DATA.SESSION_INFO_TAG)
    if (hmacData) sessionInfoTag = first(hmacData, HMAC_SIGNATURE_DATA.TAG)
  }

  // The signer identity and GCM parameters are only of interest to the
  // receiving side, but keeping one parser for both directions means the mock
  // vehicle exercises exactly the code the watch relies on.
  let commandSignature = null
  let signerPublicKey = null
  if (signature) {
    const identity = firstMessage(signature, SIGNATURE_DATA.SIGNER_IDENTITY)
    if (identity) signerPublicKey = first(identity, KEY_IDENTITY.PUBLIC_KEY)

    const gcm = firstMessage(signature, SIGNATURE_DATA.AES_GCM_PERSONALIZED)
    if (gcm) {
      commandSignature = {
        epoch: first(gcm, AES_GCM_PERSONALIZED.EPOCH),
        nonce: first(gcm, AES_GCM_PERSONALIZED.NONCE),
        counter: first(gcm, AES_GCM_PERSONALIZED.COUNTER) || 0,
        expiresAt: first(gcm, AES_GCM_PERSONALIZED.EXPIRES_AT) || 0,
        tag: first(gcm, AES_GCM_PERSONALIZED.TAG)
      }
    }
  }

  return {
    commandSignature,
    signerPublicKey,
    toDestination: parseDestination(firstMessage(fields, ROUTABLE.TO_DESTINATION)),
    fromDestination: parseDestination(firstMessage(fields, ROUTABLE.FROM_DESTINATION)),
    payload: first(fields, ROUTABLE.PROTOBUF_MESSAGE_AS_BYTES),
    sessionInfo: first(fields, ROUTABLE.SESSION_INFO),
    sessionInfoTag,
    responseSignature,
    requestUuid: first(fields, ROUTABLE.REQUEST_UUID),
    uuid: first(fields, ROUTABLE.UUID),
    flags: first(fields, ROUTABLE.FLAGS) || 0,
    operationStatus: status ? first(status, MESSAGE_STATUS.OPERATION_STATUS) : undefined,
    fault: status ? (first(status, MESSAGE_STATUS.SIGNED_MESSAGE_FAULT) || 0) : 0
  }
}

export function parseSessionInfo (bytes) {
  const fields = decode(bytes)
  return {
    counter: first(fields, SESSION_INFO.COUNTER) || 0,
    publicKey: first(fields, SESSION_INFO.PUBLIC_KEY),
    epoch: first(fields, SESSION_INFO.EPOCH),
    clockTime: first(fields, SESSION_INFO.CLOCK_TIME) || 0,
    status: first(fields, SESSION_INFO.STATUS) || 0
  }
}

export function buildSessionInfo (params) {
  const writer = createWriter()
  writeVarintField(writer, SESSION_INFO.COUNTER, params.counter)
  writeBytesField(writer, SESSION_INFO.PUBLIC_KEY, params.publicKey)
  writeBytesField(writer, SESSION_INFO.EPOCH, params.epoch)
  writeFixed32Field(writer, SESSION_INFO.CLOCK_TIME, params.clockTime)
  if (params.status) writeVarintField(writer, SESSION_INFO.STATUS, params.status)
  return finishWriter(writer)
}

export function buildSessionInfoResponse (params) {
  const hmacData = createWriter()
  writeBytesField(hmacData, HMAC_SIGNATURE_DATA.TAG, params.tag)

  const signature = createWriter()
  writeMessageField(signature, SIGNATURE_DATA.SESSION_INFO_TAG, hmacData)

  const message = createWriter()
  destination(message, ROUTABLE.TO_DESTINATION, { routingAddress: params.routingAddress })
  destination(message, ROUTABLE.FROM_DESTINATION, { domain: params.domain })
  writeBytesField(message, ROUTABLE.SESSION_INFO, params.sessionInfo)
  writeMessageField(message, ROUTABLE.SIGNATURE_DATA, signature)
  if (params.requestUuid) writeBytesField(message, ROUTABLE.REQUEST_UUID, params.requestUuid)
  return finishWriter(message)
}

export function buildCommandResponse (params) {
  const message = createWriter()
  destination(message, ROUTABLE.TO_DESTINATION, { routingAddress: params.routingAddress })
  destination(message, ROUTABLE.FROM_DESTINATION, { domain: params.domain })
  writeBytesField(message, ROUTABLE.PROTOBUF_MESSAGE_AS_BYTES, params.payload)

  if (params.fault) {
    const status = createWriter()
    writeVarintField(status, MESSAGE_STATUS.OPERATION_STATUS, 2)
    writeVarintField(status, MESSAGE_STATUS.SIGNED_MESSAGE_FAULT, params.fault)
    writeMessageField(message, ROUTABLE.SIGNED_MESSAGE_STATUS, status)
  }

  // signature_data is a oneof: an encrypted reply carries GCM parameters, while
  // a reply that only resyncs the session carries the session-info HMAC that
  // proves the new epoch and counter came from the vehicle.
  if (params.responseSignature) {
    const gcm = createWriter()
    writeBytesField(gcm, AES_GCM_RESPONSE.NONCE, params.responseSignature.nonce)
    writeVarintField(gcm, AES_GCM_RESPONSE.COUNTER, params.responseSignature.counter)
    writeBytesField(gcm, AES_GCM_RESPONSE.TAG, params.responseSignature.tag)

    const signature = createWriter()
    writeMessageField(signature, SIGNATURE_DATA.AES_GCM_RESPONSE, gcm)
    writeMessageField(message, ROUTABLE.SIGNATURE_DATA, signature)
  } else if (params.sessionInfoTag) {
    const hmacData = createWriter()
    writeBytesField(hmacData, HMAC_SIGNATURE_DATA.TAG, params.sessionInfoTag)

    const signature = createWriter()
    writeMessageField(signature, SIGNATURE_DATA.SESSION_INFO_TAG, hmacData)
    writeMessageField(message, ROUTABLE.SIGNATURE_DATA, signature)
  }

  if (params.sessionInfo) writeBytesField(message, ROUTABLE.SESSION_INFO, params.sessionInfo)
  if (params.requestUuid) writeBytesField(message, ROUTABLE.REQUEST_UUID, params.requestUuid)
  return finishWriter(message)
}

// Distinguishes an enrolment envelope (ToVCSECMessage) from a routable message.
// They are different top-level types sharing one transport, told apart by which
// field numbers are present.
export function looksLikeVcsecEnvelope (bytes) {
  try {
    const fields = decode(bytes)
    return !!fields[TO_VCSEC_MESSAGE.SIGNED_MESSAGE] &&
      !fields[ROUTABLE.TO_DESTINATION] && !fields[ROUTABLE.FROM_DESTINATION]
  } catch (e) {
    return false
  }
}

export function parseAddKeyRequest (bytes) {
  const envelope = decode(bytes)
  const signed = firstMessage(envelope, TO_VCSEC_MESSAGE.SIGNED_MESSAGE)
  if (!signed) return null

  const signatureType = first(signed, VCSEC_SIGNED_MESSAGE.SIGNATURE_TYPE)
  const payload = first(signed, VCSEC_SIGNED_MESSAGE.PROTOBUF_MESSAGE_AS_BYTES)
  if (!payload) return null

  const unsigned = decode(payload)
  const operation = firstMessage(unsigned, UNSIGNED_MESSAGE.WHITELIST_OPERATION)
  if (!operation) return null

  const permission = firstMessage(operation, WHITELIST_OPERATION.ADD_KEY_TO_WHITELIST_AND_ADD_PERMISSIONS)
  if (!permission) return null

  const key = firstMessage(permission, PERMISSION_CHANGE.KEY)
  const metadata = firstMessage(operation, WHITELIST_OPERATION.METADATA_FOR_KEY)

  return {
    signatureType,
    publicKey: key ? first(key, PUBLIC_KEY_FIELD.PUBLIC_KEY_RAW) : undefined,
    role: first(permission, PERMISSION_CHANGE.KEY_ROLE),
    formFactor: metadata ? first(metadata, KEY_METADATA.KEY_FORM_FACTOR) : undefined
  }
}

// --- VCSEC payloads ---

// RKEAction sits in a oneof, so proto3 serialises it even when the value is 0.
// Unlock is value 0 and must still appear on the wire as `10 00`; dropping it
// as a default would turn the command into a no-op the vehicle ignores.
export function rkeAction (action) {
  const writer = createWriter()
  writeVarintField(writer, UNSIGNED_MESSAGE.RKE_ACTION, action)
  return finishWriter(writer)
}

// ClosureMoveRequest carries one field per closure, so several can be actuated
// in a single message. Fields must be written in ascending order.
export function closureMove (closureFields, moveType) {
  const fields = typeof closureFields === 'number' ? [closureFields] : closureFields.slice()
  fields.sort((a, b) => a - b)

  const request = createWriter()
  for (const field of fields) writeVarintField(request, field, moveType)

  const writer = createWriter()
  writeMessageField(writer, UNSIGNED_MESSAGE.CLOSURE_MOVE_REQUEST, request)
  return finishWriter(writer)
}

// Doors are actuated one message at a time, never as a single multi-field
// request. The protobuf permits several fields at once, but Tesla's own SDK
// builds these from a switch that emits exactly one field, so a multi-field
// ClosureMoveRequest has never been on the wire from Tesla tooling and no
// firmware has been observed handling it. Sending four ordinary messages costs
// nothing and stays on the path the vehicle is known to accept.
export const DOOR_FIELDS = [
  CLOSURE_FIELD.FRONT_DRIVER_DOOR,
  CLOSURE_FIELD.FRONT_PASSENGER_DOOR,
  CLOSURE_FIELD.REAR_DRIVER_DOOR,
  CLOSURE_FIELD.REAR_PASSENGER_DOOR
]

// On a Model X this swings the door; on Model 3 and Y it releases the latch and
// pops the door ajar, which is what Tesla's own app exposes as a quick action.
// On other cars it may do nothing at all.
export function openDoor (closureField) {
  return closureMove(closureField, CLOSURE_MOVE.OPEN)
}

// Returns the sequence to open every door, in order, as separate messages.
export function openAllDoors () {
  return DOOR_FIELDS.map(openDoor)
}

// There is deliberately no closeDoors(). Only the Model X has actuators that
// pull a door shut; on every other model CLOSE is inert. Where it does fire it
// swings a falcon-wing door, and Tesla's manual explicitly declines to promise
// obstruction detection -- so the command is useless on most cars and unsafe to
// bind to a wrist button on the rest.

export function openTrunk () {
  return closureMove(CLOSURE_FIELD.REAR_TRUNK, CLOSURE_MOVE.OPEN)
}

export function closeTrunk () {
  return closureMove(CLOSURE_FIELD.REAR_TRUNK, CLOSURE_MOVE.CLOSE)
}

// Halts a closure mid-travel. Not something Tesla's SDK sends for the boot, so
// a car may ignore it -- but the cost of it being ignored is that nothing
// happens, which is exactly where you already were, and the value when it does
// work is stopping a powered panel closing on something.
export function stopClosure (closureField) {
  return closureMove(closureField, CLOSURE_MOVE.STOP)
}

export function openFrunk () {
  return closureMove(CLOSURE_FIELD.FRONT_TRUNK, CLOSURE_MOVE.OPEN)
}

// No closeFrunk. Tesla's own tooling says plainly that no remote frunk close
// exists; the bonnet has to be pressed shut by hand. A button for it would be a
// no-op wearing the clothes of a working control.

// Asks VCSEC for vehicle status, including ClosureStatuses. VCSEC acknowledges a
// command with silence, so this is the only way to distinguish "accepted and
// acted on" from "accepted and quietly ignored".
export function vehicleStatusRequest () {
  const request = createWriter()
  const writer = createWriter()
  writeMessageField(writer, UNSIGNED_MESSAGE.INFORMATION_REQUEST, request)
  return finishWriter(writer)
}

export function openChargePort () {
  return closureMove(CLOSURE_FIELD.CHARGE_PORT, CLOSURE_MOVE.OPEN)
}

export function closeChargePort () {
  return closureMove(CLOSURE_FIELD.CHARGE_PORT, CLOSURE_MOVE.CLOSE)
}

// Enrolment request. Deliberately unauthenticated -- it is the NFC keycard tap
// on the centre console that authorises adding this key, not any signature we
// could produce, since by definition the vehicle does not trust us yet.
export function buildAddKeyRequest (publicKey, role, formFactor) {
  const key = createWriter()
  writeBytesField(key, PUBLIC_KEY_FIELD.PUBLIC_KEY_RAW, publicKey)

  const permission = createWriter()
  writeMessageField(permission, PERMISSION_CHANGE.KEY, key)
  writeVarintField(permission, PERMISSION_CHANGE.KEY_ROLE, role)

  const metadata = createWriter()
  writeVarintField(metadata, KEY_METADATA.KEY_FORM_FACTOR, formFactor)

  const operation = createWriter()
  writeMessageField(operation, WHITELIST_OPERATION.ADD_KEY_TO_WHITELIST_AND_ADD_PERMISSIONS, permission)
  writeMessageField(operation, WHITELIST_OPERATION.METADATA_FOR_KEY, metadata)

  const unsigned = createWriter()
  writeMessageField(unsigned, UNSIGNED_MESSAGE.WHITELIST_OPERATION, operation)

  const signed = createWriter()
  writeBytesField(signed, VCSEC_SIGNED_MESSAGE.PROTOBUF_MESSAGE_AS_BYTES, finishWriter(unsigned))
  writeVarintField(signed, VCSEC_SIGNED_MESSAGE.SIGNATURE_TYPE, VCSEC_SIGNATURE_TYPE.PRESENT_KEY)

  const envelope = createWriter()
  writeMessageField(envelope, TO_VCSEC_MESSAGE.SIGNED_MESSAGE, signed)
  return finishWriter(envelope)
}

// Tells a bare FromVCSECMessage from a RoutableMessage.
//
// The two types share the transport but their top-level field numbers are
// disjoint: RoutableMessage reserves 1-5, 11 and 16-40, so 1/4/16/17/46 can
// never legitimately appear at its top level. Checking both directions rather
// than just one keeps a truncated or padded frame from being misrouted.
export function looksLikeBareVcsec (bytes) {
  if (!bytes || bytes.length === 0) return false

  let fields
  try {
    fields = decode(bytes)
  } catch (e) {
    return false
  }

  const vcsecFields = [
    FROM_VCSEC_MESSAGE.VEHICLE_STATUS, FROM_VCSEC_MESSAGE.COMMAND_STATUS,
    FROM_VCSEC_MESSAGE.WHITELIST_INFO, FROM_VCSEC_MESSAGE.WHITELIST_ENTRY_INFO,
    FROM_VCSEC_MESSAGE.NOMINAL_ERROR
  ]
  const routableFields = [
    ROUTABLE.TO_DESTINATION, ROUTABLE.FROM_DESTINATION,
    ROUTABLE.PROTOBUF_MESSAGE_AS_BYTES, ROUTABLE.SIGNED_MESSAGE_STATUS,
    ROUTABLE.SIGNATURE_DATA, ROUTABLE.SESSION_INFO_REQUEST, ROUTABLE.SESSION_INFO,
    ROUTABLE.REQUEST_UUID, ROUTABLE.UUID, ROUTABLE.FLAGS
  ]

  let sawVcsec = false
  for (const field of vcsecFields) if (fields[field]) sawVcsec = true
  for (const field of routableFields) if (fields[field]) return false
  return sawVcsec
}

// Decodes VehicleStatus out of a FromVCSECMessage, or null when the frame does
// not carry one. Closure states are returned keyed by their CLOSURE_FIELD
// number, which is the same numbering ClosureMoveRequest uses.
export function parseVehicleStatus (bytes) {
  let fields
  try {
    fields = decode(bytes)
  } catch (e) {
    return null
  }

  const status = firstMessage(fields, FROM_VCSEC_MESSAGE.VEHICLE_STATUS)
  if (!status) return null

  const result = {
    lockState: first(status, VEHICLE_STATUS.VEHICLE_LOCK_STATE),
    sleepStatus: first(status, VEHICLE_STATUS.VEHICLE_SLEEP_STATUS),
    userPresence: first(status, VEHICLE_STATUS.USER_PRESENCE),
    closures: {}
  }

  // Second unwrap. Both this and the one above are tag 0x0A; stopping after the
  // first would read closure fields as VehicleStatus fields.
  const closures = firstMessage(status, VEHICLE_STATUS.CLOSURE_STATUSES)
  if (closures) {
    for (const key of Object.keys(closures)) {
      const value = first(closures, Number(key))
      if (typeof value === 'number') result.closures[Number(key)] = value
    }
  }

  return result
}

export function closureStateName (state) {
  return CLOSURE_STATE_NAMES[state] || 'unknown'
}

export function lockStateName (state) {
  return VEHICLE_LOCK_STATE_NAMES[state] || 'unknown'
}

// VCSEC signals a successful action by saying nothing: an empty FromVCSECMessage
// is the acknowledgement, while any commandStatus is either a wait or a fault.
export function parseFromVcsec (bytes) {
  const fields = decode(bytes)
  const commandStatus = firstMessage(fields, FROM_VCSEC_MESSAGE.COMMAND_STATUS)
  const nominalError = firstMessage(fields, FROM_VCSEC_MESSAGE.NOMINAL_ERROR)

  return {
    empty: bytes.length === 0,
    hasCommandStatus: !!commandStatus,
    operationStatus: commandStatus ? first(commandStatus, COMMAND_STATUS.OPERATION_STATUS) : undefined,
    whitelistOperationStatus: commandStatus
      ? firstMessage(commandStatus, COMMAND_STATUS.WHITELIST_OPERATION_STATUS)
      : undefined,
    nominalError: nominalError ? (first(nominalError, 1) || 0) : undefined,
    vehicleStatus: firstMessage(fields, FROM_VCSEC_MESSAGE.VEHICLE_STATUS)
  }
}

export function faultName (fault) {
  return MESSAGE_FAULT_NAMES[fault] || ('fault ' + fault)
}

// A physical refusal from the car, as opposed to a protocol fault. Worth
// wording plainly: "something is still open" tells the driver what to do,
// whereas "error 2" does not.
export function genericErrorMessage (code) {
  return GENERIC_ERROR_MESSAGES[code] || ('error ' + code)
}
