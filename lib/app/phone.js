// Talking to the companion service on the phone.
//
// Every page that needs the phone was growing its own copy of the same three
// awkward facts about the link, and they had already drifted apart:
//
//   * `request` throws rather than rejecting when the link was never built, so
//     the call needs a try/catch as well as a .catch;
//   * with no phone in range the promise never settles at all, so it needs a
//     deadline or the screen waits for good;
//   * the deadline outlives the page. A timer that fires after onDestroy paints
//     into freed widgets, which on Zepp OS takes the app with it.
//
// A channel is owned by one page and closed with it. After close() nothing it
// was asked for can call back, so a late answer is dropped rather than landing
// on a screen that no longer exists.

import { toHex, fromHex } from '../util/hex.js'

// Why a request failed, for callers that need to tell "no phone" apart from
// "the phone said no". The distinction matters on screen: one is fixed by
// walking closer and the other is not.
export const REASON = {
  UNREACHABLE: 'unreachable',
  REFUSED: 'refused'
}

function unreachable (message) {
  const error = new Error(message)
  error.reason = REASON.UNREACHABLE
  return error
}

function refused (message) {
  const error = new Error(message)
  error.reason = REASON.REFUSED
  return error
}

export function createPhoneChannel (options) {
  // Bound to the page, because ZML reads the transport off the page object.
  const request = options.request
  const log = options.log || function () {}
  const schedule = options.setTimeout || setTimeout
  const unschedule = options.clearTimeout || clearTimeout
  const defaultTimeout = options.timeoutMs || 15000

  let closed = false

  return {
    // Called from the page's onDestroy. Outstanding requests are abandoned
    // rather than awaited: their answers have nowhere left to go.
    close () { closed = true },

    get closed () { return closed },

    ask (method, payload, callback) {
      const timeoutMs = (payload && payload.timeoutMs) || defaultTimeout

      if (closed) {
        callback(unreachable('the page is gone'))
        return
      }

      let settled = false
      let timer = null

      const finish = (err, data) => {
        if (settled) return
        settled = true
        if (timer !== null) {
          unschedule(timer)
          timer = null
        }
        // The page went away while the phone was thinking. Answering now would
        // write to widgets that no longer exist.
        if (closed) {
          log('dropping a late ' + method + ' answer for a closed page')
          return
        }
        callback(err, data)
      }

      timer = schedule(() => finish(unreachable('the phone did not answer')), timeoutMs)

      let pending
      try {
        pending = request(Object.assign({ method }, payload))
      } catch (e) {
        finish(unreachable('there is no link to the phone'))
        return
      }

      pending
        .then((data) => finish(null, data))
        .catch(() => finish(unreachable('the phone did not answer')))
    }
  }
}

// The one-time ECDH per car, as the controller wants it.
//
// Suitable as createController's `deriveSharedSecret`. Every page that builds a
// controller needs one of these, because any command can be the first this
// watch has ever sent to a given car.
export function createSharedSecretDeriver (channel) {
  return function deriveSharedSecret (privateKey, vehiclePublicKey, callback) {
    channel.ask('DERIVE_SHARED_SECRET', {
      privateHex: toHex(privateKey),
      vehiclePublicHex: toHex(vehiclePublicKey)
    }, (err, data) => {
      if (err) {
        callback(err)
        return
      }

      const shared = data && data.sharedHex ? fromHex(data.sharedHex) : null
      if (!shared || shared.length !== 32) {
        // The phone answered and declined. That is a different problem from
        // the phone being absent, and it carries a reason worth showing --
        // "the vehicle public key is not a valid curve point" is a security
        // signal, not a hint to stand closer.
        callback(refused((data && data.error) || 'the phone could not derive the secret'))
        return
      }
      callback(null, shared)
    })
  }
}
