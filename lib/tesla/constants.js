// Wire constants for Tesla's vehicle protocol, taken from the published
// vehicle-command SDK. Field numbers live here rather than in the message
// builders so that a schema change has exactly one place to be corrected.

export const SERVICE_UUID = '00000211-b2d1-43f0-9b88-960cebf8b91e'
export const WRITE_UUID = '00000212-b2d1-43f0-9b88-960cebf8b91e'
export const NOTIFY_UUID = '00000213-b2d1-43f0-9b88-960cebf8b91e'

export const DOMAIN = {
  BROADCAST: 0,
  VEHICLE_SECURITY: 2,
  INFOTAINMENT: 3
}

// Bit positions, not values: FLAG_ENCRYPT_RESPONSE is bit 1, so the flags word
// carries 2. Newer firmware encrypts its reply when this is set and older
// firmware ignores it, so it is always safe to request.
export const FLAG_ENCRYPT_RESPONSE = 1 << 1

export const SIGNATURE_TYPE = {
  AES_GCM: 0,
  AES_GCM_PERSONALIZED: 5,
  HMAC: 6,
  HMAC_PERSONALIZED: 8,
  AES_GCM_RESPONSE: 9
}

export const TAG = {
  SIGNATURE_TYPE: 0,
  DOMAIN: 1,
  PERSONALIZATION: 2,
  EPOCH: 3,
  EXPIRES_AT: 4,
  COUNTER: 5,
  CHALLENGE: 6,
  FLAGS: 7,
  REQUEST_HASH: 8,
  FAULT: 9,
  END: 255
}

// HMAC-SHA256 labels used to split the ECDH key into purpose-specific subkeys.
// Byte-exact strings; a stray character silently breaks authentication.
export const LABEL_SESSION_INFO = 'session info'
export const LABEL_MESSAGE_AUTH = 'authenticated command'

export const ROUTABLE = {
  TO_DESTINATION: 6,
  FROM_DESTINATION: 7,
  PROTOBUF_MESSAGE_AS_BYTES: 10,
  SIGNED_MESSAGE_STATUS: 12,
  SIGNATURE_DATA: 13,
  SESSION_INFO_REQUEST: 14,
  SESSION_INFO: 15,
  REQUEST_UUID: 50,
  UUID: 51,
  FLAGS: 52
}

export const DESTINATION = {
  DOMAIN: 1,
  ROUTING_ADDRESS: 2
}

export const SESSION_INFO_REQUEST = {
  PUBLIC_KEY: 1,
  CHALLENGE: 2
}

export const SESSION_INFO = {
  COUNTER: 1,
  PUBLIC_KEY: 2,
  EPOCH: 3,
  CLOCK_TIME: 4,
  STATUS: 5,
  HANDLE: 6
}

export const SESSION_INFO_STATUS = {
  OK: 0,
  KEY_NOT_ON_WHITELIST: 1
}

export const SIGNATURE_DATA = {
  SIGNER_IDENTITY: 1,
  AES_GCM_PERSONALIZED: 5,
  SESSION_INFO_TAG: 6,
  HMAC_PERSONALIZED: 8,
  AES_GCM_RESPONSE: 9
}

export const KEY_IDENTITY = {
  PUBLIC_KEY: 1,
  HANDLE: 3
}

export const AES_GCM_PERSONALIZED = {
  EPOCH: 1,
  NONCE: 2,
  COUNTER: 3,
  EXPIRES_AT: 4,
  TAG: 5
}

export const AES_GCM_RESPONSE = {
  NONCE: 1,
  COUNTER: 2,
  TAG: 3
}

export const HMAC_SIGNATURE_DATA = { TAG: 1 }

export const MESSAGE_STATUS = {
  OPERATION_STATUS: 1,
  SIGNED_MESSAGE_FAULT: 2
}

export const OPERATION_STATUS = {
  OK: 0,
  WAIT: 1,
  ERROR: 2
}

// VCSEC.UnsignedMessage
export const UNSIGNED_MESSAGE = {
  INFORMATION_REQUEST: 1,
  RKE_ACTION: 2,
  CLOSURE_MOVE_REQUEST: 4,
  WHITELIST_OPERATION: 16
}

// RKEAction_E. Note that trunk and frunk are NOT here; they are closure moves.
export const RKE_ACTION = {
  UNLOCK: 0,
  LOCK: 1,
  REMOTE_DRIVE: 20,
  AUTO_SECURE_VEHICLE: 29,
  WAKE_VEHICLE: 30
}

export const CLOSURE_MOVE = {
  NONE: 0,
  MOVE: 1,
  STOP: 2,
  OPEN: 3,
  CLOSE: 4
}

export const CLOSURE_FIELD = {
  FRONT_DRIVER_DOOR: 1,
  FRONT_PASSENGER_DOOR: 2,
  REAR_DRIVER_DOOR: 3,
  REAR_PASSENGER_DOOR: 4,
  REAR_TRUNK: 5,
  FRONT_TRUNK: 6,
  CHARGE_PORT: 7,
  TONNEAU: 8
}

export const WHITELIST_OPERATION = {
  ADD_KEY_TO_WHITELIST_AND_ADD_PERMISSIONS: 5,
  METADATA_FOR_KEY: 6
}

export const PERMISSION_CHANGE = {
  KEY: 1,
  SECONDS_TO_BE_ACTIVE: 3,
  KEY_ROLE: 4
}

export const PUBLIC_KEY_FIELD = { PUBLIC_KEY_RAW: 1 }
export const KEY_METADATA = { KEY_FORM_FACTOR: 1 }

// Keys.Role. DRIVER is what a phone key gets and it permits driving away, so it
// is the widest blast radius a compromised key could have. The lower-privilege
// roles are listed because they bound that radius, but which of them a vehicle
// will actually accept over BLE enrolment — and exactly what each permits — is
// not established here, so switching to one needs verifying against a car
// before it is trusted.
export const ROLE = {
  NONE: 0,
  SERVICE: 1,
  OWNER: 2,
  DRIVER: 3,
  FM: 4,
  VEHICLE_MONITOR: 5,
  CHARGING_MANAGER: 6,
  GUEST: 8
}

export const KEY_FORM_FACTOR = {
  UNKNOWN: 0,
  NFC_CARD: 1,
  IOS_DEVICE: 6,
  ANDROID_DEVICE: 7,
  CLOUD_KEY: 9
}

// VCSEC.ToVCSECMessage / SignedMessage, used only for key enrolment, which is
// deliberately unauthenticated because the NFC card tap is the authorisation.
export const TO_VCSEC_MESSAGE = { SIGNED_MESSAGE: 1 }
export const VCSEC_SIGNED_MESSAGE = {
  PROTOBUF_MESSAGE_AS_BYTES: 2,
  SIGNATURE_TYPE: 3
}
export const VCSEC_SIGNATURE_TYPE = {
  NONE: 0,
  PRESENT_KEY: 2
}

export const FROM_VCSEC_MESSAGE = {
  VEHICLE_STATUS: 1,
  COMMAND_STATUS: 4,
  WHITELIST_INFO: 16,
  WHITELIST_ENTRY_INFO: 17,
  NOMINAL_ERROR: 46
}

// VehicleStatus. Note that closureStatuses is field 1 inside a VehicleStatus
// that is itself field 1 of FromVCSECMessage, so a status frame opens
// `0a LL 0a LL ...` with the same tag byte twice. Unwrapping only one level
// reads lock state as if it were a door.
export const VEHICLE_STATUS = {
  CLOSURE_STATUSES: 1,
  VEHICLE_LOCK_STATE: 2,
  VEHICLE_SLEEP_STATUS: 3,
  USER_PRESENCE: 4,
  DETAILED_CLOSURE_STATUS: 5
}

// ClosureStatuses uses the same field numbers as ClosureMoveRequest, which is
// cross-checked by the known-good commands: rearTrunk is 5 in both (22 02 28 03)
// and frontTrunk is 6 in both (22 02 30 03).
export const CLOSURE_STATE = {
  CLOSED: 0,
  OPEN: 1,
  AJAR: 2,
  UNKNOWN: 3,
  FAILED_UNLATCH: 4,
  OPENING: 5,
  CLOSING: 6
}

export const CLOSURE_STATE_NAMES = {
  0: 'closed',
  1: 'open',
  2: 'ajar',
  3: 'unknown',
  4: 'failed to unlatch',
  5: 'opening',
  6: 'closing'
}

export const VEHICLE_LOCK_STATE = {
  UNLOCKED: 0,
  LOCKED: 1,
  INTERNAL_LOCKED: 2,
  SELECTIVE_UNLOCKED: 3
}

export const VEHICLE_LOCK_STATE_NAMES = {
  0: 'unlocked',
  1: 'locked',
  2: 'locked from inside',
  3: 'partly unlocked'
}

// How much a reported value can be believed.
//
// VERIFIED  - arrived as an authenticated reply to our own request, so it came
//             from the holder of the session key and answers this request.
// REPORTED  - a solicited reply that arrived in plaintext. Older firmware does
//             this legitimately, but nothing rules out injection.
// OVERHEARD - an unsolicited broadcast. Not signed, not counter-bound, not
//             session-bound. Anyone in radio range can send one.
export const TRUST = {
  VERIFIED: 'verified',
  REPORTED: 'reported',
  OVERHEARD: 'overheard'
}

export const COMMAND_STATUS = {
  OPERATION_STATUS: 1,
  SIGNED_MESSAGE_STATUS: 2,
  WHITELIST_OPERATION_STATUS: 3
}

export const MESSAGE_FAULT_NAMES = {
  0: 'none',
  1: 'busy',
  2: 'timeout',
  3: 'unknown key id',
  4: 'inactive key',
  5: 'invalid signature',
  6: 'invalid token or counter',
  7: 'insufficient privileges',
  8: 'invalid domains',
  9: 'invalid command',
  10: 'decoding failed',
  11: 'internal error',
  12: 'wrong personalization',
  13: 'bad parameter',
  14: 'keychain is full',
  15: 'incorrect epoch',
  16: 'iv incorrect length',
  17: 'time expired',
  18: 'not provisioned with identity',
  19: 'could not hash metadata',
  20: 'time to live too long',
  21: 'remote access disabled',
  22: 'remote service access disabled',
  23: 'command requires account credentials',
  24: 'request mtu exceeded',
  25: 'response mtu exceeded',
  26: 'repeated counter',
  27: 'invalid key handle',
  28: 'requires response encryption'
}

// Errors.GenericError_E, returned in FromVCSECMessage.nominalError. These are
// the vehicle declining for a physical reason rather than a protocol fault, so
// they are worth showing verbatim: CLOSURES_OPEN is exactly what comes back
// when a lock is refused because a door is standing open.
export const GENERIC_ERROR = {
  NONE: 0,
  UNKNOWN: 1,
  CLOSURES_OPEN: 2,
  ALREADY_ON: 3,
  DISABLED_FOR_USER_COMMAND: 4,
  VEHICLE_NOT_IN_PARK: 5,
  UNAUTHORIZED: 6,
  NOT_ALLOWED_OVER_TRANSPORT: 7
}

export const GENERIC_ERROR_MESSAGES = {
  0: 'no error',
  1: 'the car could not do that',
  2: 'something is still open',
  3: 'already done',
  4: 'that is disabled on this car',
  5: 'the car is not in park',
  6: 'this key is not allowed to do that',
  7: 'not allowed over Bluetooth'
}

export const DEFAULT_EXPIRES_IN_SECONDS = 5
export const MAX_MESSAGE_SIZE = 1024
export const RX_TIMEOUT_MS = 1000
