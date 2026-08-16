// A stand-in Tesla that speaks the real protocol.
//
// The Zepp simulator has no Bluetooth of any kind, so this is where the client
// gets exercised. Two deliberate choices make it a genuine test rather than a
// mirror of the implementation under test:
//
//   * every cryptographic operation on this side runs through Node's OpenSSL
//     bindings, so an ECDH, AES-GCM or HMAC bug in the watch code shows up as
//     a mismatch instead of cancelling out;
//   * the signature metadata is encoded independently here, because a shared
//     encoder that got the TLV layout wrong would agree with itself and pass.
//
// It also enforces the rules a real car enforces -- whitelist membership,
// epoch, strictly increasing counters, expiry -- so those paths get covered
// without a vehicle present.

import crypto from 'node:crypto'

import {
  parseRoutableMessage, parseSessionInfo, buildSessionInfo,
  buildSessionInfoResponse, buildCommandResponse, looksLikeVcsecEnvelope,
  parseAddKeyRequest
} from '../lib/tesla/messages.js'
import {
  createWriter, writeVarintField, writeMessageField, finishWriter, decode, first
} from '../lib/tesla/protobuf.js'
import {
  DOMAIN, UNSIGNED_MESSAGE, FROM_VCSEC_MESSAGE, COMMAND_STATUS,
  OPERATION_STATUS, VCSEC_SIGNATURE_TYPE, SESSION_INFO_STATUS, VEHICLE_STATUS
} from '../lib/tesla/constants.js'

function u32be (value) {
  const out = Buffer.alloc(4)
  out.writeUInt32BE(value >>> 0)
  return out
}

// Independent TLV encoder: tag, length, value, ascending, closed with 0xFF.
function encodeMetadata (entries) {
  const parts = []
  for (const entry of entries) {
    if (!entry || entry[1] === null || entry[1] === undefined) continue
    const value = Buffer.from(entry[1])
    parts.push(Buffer.from([entry[0], value.length]), value)
  }
  parts.push(Buffer.from([0xff]))
  return Buffer.concat(parts)
}

function sha256 (buf) {
  return crypto.createHash('sha256').update(buf).digest()
}

export function createMockVehicle (options) {
  const settings = options || {}
  const vin = settings.vin || '5YJ30123456789ABC'
  const log = settings.log || function () {}

  const ec = crypto.createECDH('prime256v1')
  ec.generateKeys()

  const epoch = crypto.randomBytes(16)
  const vinBytes = Buffer.from(vin, 'ascii')

  let clockTime = settings.clockTime === undefined ? 5000 : settings.clockTime
  const whitelist = new Set()
  const domains = {}
  const events = []

  let deliver = null
  let pendingEnrolment = null
  // Lets a test force a stale-counter fault to exercise the resync path.
  let injectCounterFault = false
  // Models a door standing open, which makes the car refuse to lock.
  let doorOpen = false
  // Reported closure states, keyed by CLOSURE_FIELD. Everything shut by default.
  const closures = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 }
  let lockState = 1

  function domainState (domain) {
    if (!domains[domain]) domains[domain] = { counter: 0, responseCounter: 0 }
    return domains[domain]
  }

  function sessionKeyFor (clientPublicKey) {
    const sharedX = ec.computeSecret(Buffer.from(clientPublicKey))
    return crypto.createHash('sha1').update(sharedX).digest().subarray(0, 16)
  }

  function sessionInfoTag (key, challenge, rawSessionInfo) {
    const meta = encodeMetadata([
      [0, [6]],
      [2, vinBytes],
      challenge && challenge.length ? [6, Buffer.from(challenge)] : null
    ])
    const subkey = crypto.createHmac('sha256', key).update('session info').digest()
    return crypto.createHmac('sha256', subkey)
      .update(Buffer.concat([meta, Buffer.from(rawSessionInfo)])).digest()
  }

  function commandAad (domain, counter, expiresAt, flags) {
    const entries = [
      [0, [5]],
      [1, [domain]],
      [2, vinBytes],
      [3, epoch],
      [4, u32be(expiresAt)],
      [5, u32be(counter)]
    ]
    if (flags > 0) entries.push([7, u32be(flags)])
    return sha256(encodeMetadata(entries))
  }

  function responseAad (domain, counter, flags, requestHash, fault) {
    return sha256(encodeMetadata([
      [0, [9]],
      [1, [domain]],
      [2, vinBytes],
      [5, u32be(counter)],
      [7, u32be(flags || 0)],
      [8, Buffer.from(requestHash)],
      [9, u32be(fault || 0)]
    ]))
  }

  function send (bytes) {
    if (!deliver) return
    const copy = new Uint8Array(bytes)
    setImmediate(() => deliver(copy))
  }

  function currentSessionInfo (key, counterOverride) {
    return buildSessionInfo({
      counter: counterOverride === undefined ? domainState(DOMAIN.VEHICLE_SECURITY).counter : counterOverride,
      publicKey: new Uint8Array(ec.getPublicKey(null, 'uncompressed')),
      epoch: new Uint8Array(epoch),
      clockTime,
      status: key ? SESSION_INFO_STATUS.OK : SESSION_INFO_STATUS.KEY_NOT_ON_WHITELIST
    })
  }

  function handleHandshake (message) {
    const fields = decode(message.raw)
    const requestFields = decode(first(fields, 14))
    const clientPublicKey = first(requestFields, 1)

    if (!clientPublicKey || clientPublicKey.length !== 65) {
      log('handshake with a malformed public key')
      return
    }

    const enrolled = whitelist.has(Buffer.from(clientPublicKey).toString('hex'))
    const key = sessionKeyFor(clientPublicKey)
    const state = domainState(message.toDestination.domain)

    const info = currentSessionInfo(enrolled ? key : null, state.counter)
    const tag = sessionInfoTag(key, message.uuid, info)

    log('handshake from ' + (enrolled ? 'an enrolled key' : 'an UNKNOWN key'))
    events.push({ type: 'handshake', enrolled })

    send(buildSessionInfoResponse({
      domain: message.toDestination.domain,
      routingAddress: message.fromDestination.routingAddress,
      sessionInfo: info,
      tag,
      requestUuid: message.uuid
    }))
  }

  function respondWithFault (message, fault, key) {
    const domain = message.toDestination.domain
    const info = currentSessionInfo(key, domainState(domain).counter)

    log('rejecting command with fault ' + fault)
    send(buildCommandResponse({
      domain,
      routingAddress: message.fromDestination.routingAddress,
      fault,
      sessionInfo: info,
      // The attached session info has to be authenticated, or a bystander could
      // feed the client a forged epoch and counter and stall it indefinitely.
      sessionInfoTag: key ? sessionInfoTag(key, message.uuid, info) : undefined,
      requestUuid: message.uuid
    }))
  }

  function handleCommand (message) {
    const domain = message.toDestination.domain
    const signature = message.commandSignature
    const state = domainState(domain)

    const publicKey = message.signerPublicKey
    if (!publicKey || !whitelist.has(Buffer.from(publicKey).toString('hex'))) {
      // 3 = UNKNOWN_KEY_ID
      respondWithFault(message, 3, null)
      return
    }

    const key = sessionKeyFor(publicKey)

    if (!Buffer.from(signature.epoch).equals(epoch)) {
      respondWithFault(message, 15, key) // INCORRECT_EPOCH
      return
    }
    if (injectCounterFault || signature.counter <= state.counter) {
      injectCounterFault = false
      respondWithFault(message, 26, key) // REPEATED_COUNTER
      return
    }
    if (signature.expiresAt < clockTime) {
      respondWithFault(message, 17, key) // TIME_EXPIRED
      return
    }

    let plaintext
    try {
      const decipher = crypto.createDecipheriv('aes-128-gcm', key, Buffer.from(signature.nonce))
      decipher.setAAD(commandAad(domain, signature.counter, signature.expiresAt, message.flags))
      decipher.setAuthTag(Buffer.from(signature.tag))
      plaintext = Buffer.concat([decipher.update(Buffer.from(message.payload)), decipher.final()])
    } catch (e) {
      respondWithFault(message, 5, key) // INVALID_SIGNATURE
      return
    }

    state.counter = signature.counter

    const action = decode(new Uint8Array(plaintext))
    const rke = first(action, UNSIGNED_MESSAGE.RKE_ACTION)
    const closure = first(action, UNSIGNED_MESSAGE.CLOSURE_MOVE_REQUEST)
    const information = first(action, UNSIGNED_MESSAGE.INFORMATION_REQUEST)

    if (information !== undefined) {
      log('reporting vehicle status')
      events.push({ type: 'status-request' })
      sendVcsecPayload(message, key, buildVehicleStatus())
      return
    }

    if (rke !== undefined) {
      // A real car refuses to lock while something is standing open, and says
      // so with GenericError_E CLOSURES_OPEN rather than failing silently.
      if (rke === 1 && doorOpen) {
        log('refusing to lock: a door is open')
        events.push({ type: 'lock-refused', reason: 'closures-open' })
        sendVcsecPayload(message, key, nominalError(2))
        return
      }
      log('executing RKE action ' + rke)
      events.push({ type: 'rke', action: rke })
    } else if (closure !== undefined) {
      // A single request may actuate several closures, so every field present
      // is recorded rather than just the first.
      const closureFields = decode(closure)
      const moves = Object.keys(closureFields).map((key) => ({
        field: Number(key),
        move: first(closureFields, Number(key))
      }))
      log('executing closure moves: ' + moves.map((m) => m.field + '=' + m.move).join(', '))
      events.push({ type: 'closure', moves, field: moves[0].field, move: moves[0].move })
    } else {
      events.push({ type: 'unknown-command' })
    }

    // An empty FromVCSECMessage is how VCSEC acknowledges success.
    const responsePayload = Buffer.alloc(0)
    const requestHash = Buffer.concat([Buffer.from([5]), Buffer.from(signature.tag).subarray(0, 16)])

    if (message.flags & 2) {
      state.responseCounter += 1
      const nonce = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-128-gcm', key, nonce)
      cipher.setAAD(responseAad(domain, state.responseCounter, 0, requestHash, 0))
      const ciphertext = Buffer.concat([cipher.update(responsePayload), cipher.final()])

      send(buildCommandResponse({
        domain,
        routingAddress: message.fromDestination.routingAddress,
        payload: new Uint8Array(ciphertext),
        responseSignature: {
          nonce: new Uint8Array(nonce),
          counter: state.responseCounter,
          tag: new Uint8Array(cipher.getAuthTag())
        },
        requestUuid: message.uuid
      }))
    } else {
      send(buildCommandResponse({
        domain,
        routingAddress: message.fromDestination.routingAddress,
        payload: new Uint8Array(responsePayload),
        requestUuid: message.uuid
      }))
    }
  }

  // FromVCSECMessage.vehicleStatus (1) -> VehicleStatus, whose closureStatuses
  // is itself field 1 -- the frame opens 0a..0a.., which is exactly the nesting
  // a client can get wrong.
  function buildVehicleStatus () {
    const closureStatuses = createWriter()
    for (const key of Object.keys(closures)) {
      writeVarintField(closureStatuses, Number(key), closures[key])
    }

    const status = createWriter()
    writeMessageField(status, VEHICLE_STATUS.CLOSURE_STATUSES, closureStatuses)
    writeVarintField(status, VEHICLE_STATUS.VEHICLE_LOCK_STATE, lockState)

    const outer = createWriter()
    writeMessageField(outer, FROM_VCSEC_MESSAGE.VEHICLE_STATUS, status)
    return finishWriter(outer)
  }

  // FromVCSECMessage.nominalError (field 46) -> NominalError.genericError (1).
  function nominalError (code) {
    const inner = createWriter()
    writeVarintField(inner, 1, code)
    const outer = createWriter()
    writeMessageField(outer, FROM_VCSEC_MESSAGE.NOMINAL_ERROR, inner)
    return finishWriter(outer)
  }

  // Sends a VCSEC payload back to the client, encrypting it when the request
  // asked for an encrypted response, so error paths take the same route as
  // successful ones.
  function sendVcsecPayload (message, key, payload) {
    const domain = message.toDestination.domain
    const state = domainState(domain)
    const signature = message.commandSignature
    const requestHash = Buffer.concat([Buffer.from([5]), Buffer.from(signature.tag).subarray(0, 16)])

    if (message.flags & 2) {
      state.responseCounter += 1
      const nonce = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-128-gcm', key, nonce)
      cipher.setAAD(responseAad(domain, state.responseCounter, 0, requestHash, 0))
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(payload)), cipher.final()])

      send(buildCommandResponse({
        domain,
        routingAddress: message.fromDestination.routingAddress,
        payload: new Uint8Array(ciphertext),
        responseSignature: {
          nonce: new Uint8Array(nonce),
          counter: state.responseCounter,
          tag: new Uint8Array(cipher.getAuthTag())
        },
        requestUuid: message.uuid
      }))
      return
    }

    send(buildCommandResponse({
      domain,
      routingAddress: message.fromDestination.routingAddress,
      payload: new Uint8Array(payload),
      requestUuid: message.uuid
    }))
  }

  function vcsecStatus (operationStatus) {
    const status = createWriter()
    writeVarintField(status, COMMAND_STATUS.OPERATION_STATUS, operationStatus)
    const outer = createWriter()
    writeMessageField(outer, FROM_VCSEC_MESSAGE.COMMAND_STATUS, status)
    return finishWriter(outer)
  }

  function handleEnrolment (bytes) {
    const request = parseAddKeyRequest(bytes)
    if (!request || request.signatureType !== VCSEC_SIGNATURE_TYPE.PRESENT_KEY) {
      log('malformed enrolment request')
      return
    }

    // A real vehicle waits here for the owner to tap an enrolled NFC keycard on
    // the centre console. Nothing the requester sends can substitute for that,
    // which is the whole reason an unauthenticated request is safe to accept.
    pendingEnrolment = request
    log('enrolment requested; waiting for an NFC keycard tap')
    events.push({ type: 'enrolment-requested', role: request.role })
    send(vcsecStatus(OPERATION_STATUS.WAIT))
  }

  function receive (bytes) {
    if (looksLikeVcsecEnvelope(bytes)) {
      handleEnrolment(bytes)
      return
    }

    let message
    try {
      message = parseRoutableMessage(bytes)
    } catch (e) {
      log('undecodable message: ' + e.message)
      return
    }
    message.raw = bytes

    if (!message.toDestination || message.toDestination.domain === undefined) return

    const fields = decode(bytes)
    if (fields[14]) handleHandshake(message)
    else if (message.commandSignature) handleCommand(message)
  }

  return {
    // The half of the link the client talks to.
    link: {
      send: receive,
      onMessage (callback) { deliver = callback }
    },

    publicKey: new Uint8Array(ec.getPublicKey(null, 'uncompressed')),
    events,

    // Enrols a key directly, standing in for a completed NFC approval.
    enrol (publicKey) {
      whitelist.add(Buffer.from(publicKey).toString('hex'))
    },

    isEnrolled (publicKey) {
      return whitelist.has(Buffer.from(publicKey).toString('hex'))
    },

    // Models the owner tapping their keycard to approve a pending request.
    tapKeycard () {
      if (!pendingEnrolment) return false
      whitelist.add(Buffer.from(pendingEnrolment.publicKey).toString('hex'))
      pendingEnrolment = null
      events.push({ type: 'enrolment-approved' })
      send(vcsecStatus(OPERATION_STATUS.OK))
      return true
    },

    // Rotates the epoch the way a real module does at boot, invalidating
    // every session established before it.
    reboot () {
      crypto.randomFillSync(epoch)
      for (const key of Object.keys(domains)) delete domains[key]
      log('vehicle rebooted; epoch rotated')
    },

    failNextCounter () {
      injectCounterFault = true
    },

    // A car with a door ajar declines to lock; everything else still works.
    setDoorOpen (open) {
      doorOpen = !!open
    },

    // Sets what the car reports for a given closure, so the watch's indicator
    // can be tested against known state.
    setClosureState (closureField, state) {
      closures[closureField] = state
    },

    setLockState (state) {
      lockState = state
    },

    advanceClock (seconds) {
      clockTime += seconds
    },

    get clockTime () {
      return clockTime
    }
  }
}
