// Protocol client: handshake, session upkeep, and signed commands.
//
// Callback-based rather than promise-based on purpose. The watch runs QuickJS
// with no job-queue guarantees worth relying on, and a key fob that hangs
// because a microtask never drained is worse than slightly noisier code.
//
// Only one request is in flight at a time. VCSEC frequently omits request_uuid
// from its replies, so responses are matched on the routing address instead,
// which means overlapping requests could not be told apart.

import {
  buildSessionInfoRequest, buildSignedCommand, parseRoutableMessage,
  parseSessionInfo, parseFromVcsec, rkeAction, buildAddKeyRequest, faultName,
  genericErrorMessage, looksLikeBareVcsec, parseVehicleStatus,
  openTrunk, closeTrunk, stopClosure, openFrunk, openDoor, openAllDoors,
  openChargePort, closeChargePort, vehicleStatusRequest
} from './messages.js'
import {
  createSessionState, applySessionInfo, nextCounter, expiresAt as computeExpiry,
  deriveSessionKey, verifySessionInfo, encryptCommand, decryptResponse, requestHash
} from './session.js'
import {
  DOMAIN, RKE_ACTION, ROLE, KEY_FORM_FACTOR, FLAG_ENCRYPT_RESPONSE,
  SIGNATURE_TYPE, OPERATION_STATUS, SESSION_INFO_STATUS, CLOSURE_FIELD,
  DEFAULT_EXPIRES_IN_SECONDS, TRUST
} from './constants.js'

const REQUEST_TIMEOUT_MS = 8000
const HANDSHAKE_TIMEOUT_MS = 10000

function bytesEqual (a, b) {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function toHex (bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += '0123456789abcdef'[(bytes[i] >>> 4) & 15] + '0123456789abcdef'[bytes[i] & 15]
  }
  return out
}

export function createClient (options) {
  const vin = options.vin
  const privateKey = options.privateKey
  const publicKey = options.publicKey
  const link = options.link
  const randomBytes = options.randomBytes
  // GCM nonces come from a counter rather than the random source when one is
  // supplied, so uniqueness does not rest on the quality of the watch's DRBG.
  const nextNonce = options.nonceSource || (() => randomBytes(12))
  const now = options.now || (() => Math.floor(Date.now() / 1000))
  const log = options.log || function () {}
  const schedule = options.setTimeout || setTimeout
  const unschedule = options.clearTimeout || clearTimeout

  // Persisting this across runs is what keeps unlocking fast: it avoids the
  // elliptic-curve work, which is the only slow step in the whole protocol.
  const keyCache = options.sessionKeyCache || {
    store: {},
    get (id) { return this.store[id] },
    set (id, value) { this.store[id] = value }
  }

  const sessions = {}
  let pending = null
  let statusHandler = options.onStatus || null
  // How much the reply currently being decoded can be believed.
  let lastResponseTrust = TRUST.REPORTED

  function sessionFor (domain) {
    if (!sessions[domain]) sessions[domain] = createSessionState()
    return sessions[domain]
  }

  function settle (error, result) {
    if (!pending) return
    const callback = pending.callback
    unschedule(pending.timer)
    pending = null
    callback(error, result)
  }

  function startRequest (descriptor, callback) {
    if (pending) {
      callback(new Error('a request is already in flight'))
      return null
    }

    pending = {
      domain: descriptor.domain,
      routingAddress: descriptor.routingAddress,
      uuid: descriptor.uuid,
      kind: descriptor.kind,
      requestTag: descriptor.requestTag,
      retried: false,
      replay: descriptor.replay,
      callback,
      timer: schedule(() => {
        const kind = pending ? pending.kind : 'request'
        pending = null
        callback(new Error(kind + ' timed out'))
      }, descriptor.timeout)
    }
    return pending
  }

  // Derives the session key, reusing a cached one when this vehicle key has
  // been seen before. The ECDH is the expensive operation on a watch, so it is
  // deliberately done at most once per vehicle.
  function sessionKeyFor (vehiclePublicKey) {
    const id = toHex(vehiclePublicKey)
    const cached = keyCache.get(id)
    if (cached) return cached

    const derived = deriveSessionKey(privateKey, vehiclePublicKey)
    if (!derived) return null

    keyCache.set(id, derived)
    log('derived a new session key for vehicle key ' + id.slice(0, 16))
    return derived
  }

  function handleSessionInfo (message, isHandshake) {
    const raw = message.sessionInfo
    const info = parseSessionInfo(raw)

    if (!info.publicKey || info.publicKey.length !== 65) {
      settle(new Error('vehicle sent a malformed public key'))
      return false
    }

    const sessionKey = sessionKeyFor(info.publicKey)
    if (!sessionKey) {
      settle(new Error('vehicle public key is not a valid curve point'))
      return false
    }

    // The vehicle signed the exact bytes it sent; verifying a re-encoding of
    // the parsed fields would compare a different byte string.
    const challenge = message.requestUuid
    if (!verifySessionInfo(sessionKey, vin, challenge, raw, message.sessionInfoTag)) {
      settle(new Error('session info failed authentication'))
      return false
    }

    // When the vehicle does echo a uuid, it must be the one we sent.
    if (challenge && challenge.length > 0 && pending && !bytesEqual(challenge, pending.uuid)) {
      settle(new Error('session info answered a different request'))
      return false
    }

    if (info.status === SESSION_INFO_STATUS.KEY_NOT_ON_WHITELIST) {
      settle(new Error('this key is not enrolled in the vehicle'))
      return false
    }

    const domain = isHandshake ? pending.domain : message.fromDestination.domain
    applySessionInfo(sessionFor(domain), info, sessionKey, now())
    log('session established for domain ' + domain + ' at counter ' + info.counter)
    return true
  }

  function decodeCommandResponse (message, session) {
    // A frame carrying no payload field at all is not an acknowledgement of
    // anything. An empty payload IS one -- VCSEC acknowledges with an empty
    // FromVCSECMessage -- so the two must not be conflated.
    if (message.payload === undefined) return undefined

    if (!message.responseSignature) {
      // Firmware before 2024.38 genuinely answers in plaintext, so refusing
      // outright would break those cars. But we always ask for an encrypted
      // reply, so an unsigned one is unauthenticated and is marked as such
      // rather than being trusted like a verified one.
      lastResponseTrust = TRUST.REPORTED
      return message.payload
    }

    const plaintext = decryptResponse({
      sessionKey: session.sessionKey,
      domain: message.fromDestination ? message.fromDestination.domain : pending.domain,
      vin,
      counter: message.responseSignature.counter,
      flags: message.flags,
      requestHash: requestHash(SIGNATURE_TYPE.AES_GCM_PERSONALIZED, pending.requestTag),
      fault: message.fault,
      nonce: message.responseSignature.nonce,
      ciphertext: message.payload,
      tag: message.responseSignature.tag
    })

    if (!plaintext) {
      settle(new Error('response failed authentication'))
      return null
    }

    // Decryption succeeded against additional data that folds in this specific
    // request's hash, so the frame provably came from the session-key holder
    // and answers this request.
    lastResponseTrust = TRUST.VERIFIED
    return plaintext
  }

  // An unsolicited FromVCSECMessage. Nothing authenticates it, so it is only
  // ever surfaced as overheard.
  function handleBroadcast (bytes) {
    const status = parseVehicleStatus(bytes)
    if (!status) return
    if (statusHandler) statusHandler(status, TRUST.OVERHEARD)
  }

  function handleMessage (bytes) {
    // VCSEC also emits bare FromVCSECMessage frames that are not routable
    // messages at all. Parsing one as a RoutableMessage would yield a
    // destination-less frame that the matcher below must never accept.
    if (looksLikeBareVcsec(bytes)) {
      handleBroadcast(bytes)
      return
    }

    let message
    try {
      message = parseRoutableMessage(bytes)
    } catch (e) {
      log('could not parse an inbound message: ' + e.message)
      return
    }

    if (!pending) return

    // A frame may settle a pending request only when it names that request's
    // routing address. Written as a whitelist on purpose: the earlier form
    // tested "address present AND different", so a frame with no address at all
    // fell straight through and settled whatever was waiting -- turning any
    // stray broadcast into a forged success.
    const routingAddress = message.toDestination && message.toDestination.routingAddress
    if (!routingAddress || !bytesEqual(routingAddress, pending.routingAddress)) return

    if (pending.kind === 'handshake') {
      if (!message.sessionInfo) return
      if (handleSessionInfo(message, true)) settle(null, { established: true })
      return
    }

    // A fault carrying fresh session info means our counter or epoch drifted;
    // adopt the vehicle's view and replay the command once.
    if (message.fault !== 0) {
      if (message.sessionInfo && !pending.retried && pending.replay) {
        log('resyncing after ' + faultName(message.fault))
        if (!handleSessionInfo(message, false)) return

        const replay = pending.replay
        const callback = pending.callback
        unschedule(pending.timer)
        pending = null
        replay(callback, true)
        return
      }
      settle(new Error('vehicle rejected the command: ' + faultName(message.fault)))
      return
    }

    if (message.sessionInfo) handleSessionInfo(message, false)

    const session = sessionFor(pending.domain)
    lastResponseTrust = TRUST.REPORTED
    const plaintext = decodeCommandResponse(message, session)

    // null means authentication failed and settle() has already reported it;
    // undefined means the frame carried no payload, so it acknowledges nothing
    // and we keep waiting rather than treating silence as success.
    if (plaintext === null) return
    if (plaintext === undefined) return

    const status = parseFromVcsec(plaintext)

    // A status frame that came back as a genuine reply is worth surfacing, and
    // unlike a broadcast it carries the trust level of the reply itself.
    const vehicleStatus = parseVehicleStatus(plaintext)
    if (vehicleStatus && statusHandler) statusHandler(vehicleStatus, lastResponseTrust)

    // VCSEC answers a successful action with silence: an empty message is the
    // acknowledgement, while a populated commandStatus is a wait or a failure.
    if (status.operationStatus === OPERATION_STATUS.WAIT) {
      log('vehicle is busy, still waiting')
      return
    }
    // A bare ERROR with nothing more specific is legacy noise that older
    // clients relied on; treating it as success would be badly wrong, and
    // treating it as failure would be premature. Wait for something specific.
    if (status.operationStatus === OPERATION_STATUS.ERROR && status.nominalError === undefined) {
      log('vehicle reported a non-specific error, still waiting')
      return
    }
    if (status.nominalError !== undefined) {
      // The car declining for a physical reason, not a protocol failure. A lock
      // refused because a door is open lands here as CLOSURES_OPEN.
      const error = new Error(genericErrorMessage(status.nominalError))
      error.genericError = status.nominalError
      settle(error)
      return
    }
    settle(null, status)
  }

  link.onMessage(handleMessage)

  function handshake (domain, callback) {
    const routingAddress = randomBytes(16)
    const uuid = randomBytes(16)

    const request = startRequest({
      domain,
      routingAddress,
      uuid,
      kind: 'handshake',
      timeout: HANDSHAKE_TIMEOUT_MS
    }, callback)
    if (!request) return

    link.send(buildSessionInfoRequest({ domain, publicKey, routingAddress, uuid }))
  }

  function sendCommand (domain, plaintext, callback) {
    const session = sessionFor(domain)
    if (!session.established) {
      handshake(domain, (err) => {
        if (err) return callback(err)
        sendCommand(domain, plaintext, callback)
      })
      return
    }

    const transmit = (cb, isRetry) => {
      const routingAddress = randomBytes(16)
      const uuid = randomBytes(16)
      const counter = nextCounter(session)
      const expiry = computeExpiry(session, now(), DEFAULT_EXPIRES_IN_SECONDS)
      const flags = FLAG_ENCRYPT_RESPONSE

      const encrypted = encryptCommand({
        sessionKey: session.sessionKey,
        domain,
        vin,
        epoch: session.epoch,
        expiresAt: expiry,
        counter,
        flags,
        plaintext,
        nonce: nextNonce()
      })

      const request = startRequest({
        domain,
        routingAddress,
        uuid,
        kind: 'command',
        requestTag: encrypted.tag,
        replay: isRetry ? null : transmit,
        timeout: REQUEST_TIMEOUT_MS
      }, cb)
      if (!request) return
      if (isRetry) request.retried = true

      link.send(buildSignedCommand({
        domain,
        routingAddress,
        ciphertext: encrypted.ciphertext,
        publicKey,
        epoch: session.epoch,
        nonce: encrypted.nonce,
        counter,
        expiresAt: expiry,
        tag: encrypted.tag,
        uuid,
        flags
      }))
    }

    transmit(callback, false)
  }

  // Sends payloads one at a time, each waiting for the previous to be
  // acknowledged. Only one request can be in flight, and a car that rejects the
  // first door is unlikely to accept the rest, so this stops at the first error.
  function sendSequence (domain, payloads, callback) {
    let index = 0

    function next () {
      if (index >= payloads.length) {
        callback(null, { sent: payloads.length })
        return
      }
      const payload = payloads[index]
      index += 1
      sendCommand(domain, payload, (err) => {
        if (err) {
          callback(err, { sent: index - 1 })
          return
        }
        next()
      })
    }

    next()
  }

  return {
    handshake,
    sendCommand,

    isReady (domain) {
      return sessionFor(domain === undefined ? DOMAIN.VEHICLE_SECURITY : domain).established
    },

    unlock (cb) { sendCommand(DOMAIN.VEHICLE_SECURITY, rkeAction(RKE_ACTION.UNLOCK), cb) },
    lock (cb) { sendCommand(DOMAIN.VEHICLE_SECURITY, rkeAction(RKE_ACTION.LOCK), cb) },
    wake (cb) { sendCommand(DOMAIN.VEHICLE_SECURITY, rkeAction(RKE_ACTION.WAKE_VEHICLE), cb) },
    openTrunk (cb) { sendCommand(DOMAIN.VEHICLE_SECURITY, openTrunk(), cb) },
    closeTrunk (cb) { sendCommand(DOMAIN.VEHICLE_SECURITY, closeTrunk(), cb) },
    stopTrunk (cb) { sendCommand(DOMAIN.VEHICLE_SECURITY, stopClosure(CLOSURE_FIELD.REAR_TRUNK), cb) },
    openFrunk (cb) { sendCommand(DOMAIN.VEHICLE_SECURITY, openFrunk(), cb) },

    openDoor (closureField, cb) {
      sendCommand(DOMAIN.VEHICLE_SECURITY, openDoor(closureField), cb)
    },

    // Four separate messages rather than one multi-field request, sent in
    // order, stopping at the first failure.
    openDoors (cb) { sendSequence(DOMAIN.VEHICLE_SECURITY, openAllDoors(), cb) },

    openChargePort (cb) { sendCommand(DOMAIN.VEHICLE_SECURITY, openChargePort(), cb) },
    closeChargePort (cb) { sendCommand(DOMAIN.VEHICLE_SECURITY, closeChargePort(), cb) },

    // VCSEC acknowledges by saying nothing, so a status read is the only way to
    // learn whether a closure actually moved.
    requestVehicleStatus (cb) {
      sendCommand(DOMAIN.VEHICLE_SECURITY, vehicleStatusRequest(), cb)
    },

    // Asks the vehicle to enrol this public key. Unauthenticated by design:
    // the owner authorises it by tapping an existing NFC keycard on the centre
    // console, which is the only thing that can grant a new key.
    requestEnrolment (role, formFactor) {
      link.send(buildAddKeyRequest(
        publicKey,
        role === undefined ? ROLE.DRIVER : role,
        formFactor === undefined ? KEY_FORM_FACTOR.ANDROID_DEVICE : formFactor
      ))
    },

    reset () {
      if (pending) {
        unschedule(pending.timer)
        pending = null
      }
      for (const domain of Object.keys(sessions)) delete sessions[domain]
    }
  }
}
