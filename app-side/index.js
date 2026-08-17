// Phone-side companion.
//
// It carries the VIN from the settings screen to the watch, because settings
// storage lives on the phone and the watch cannot read it directly. It also
// does every elliptic-curve sum this app needs, of which there are exactly two
// per car and both are one-time:
//
//   * generating the watch's keypair, at pairing;
//   * the ECDH shared secret, on first contact with a given vehicle.
//
// Both are the same P-256 scalar multiplication -- about 14ms in this engine
// and about 87 seconds on the watch's interpreter, with no native crypto on
// Zepp OS to fall back on. The watch caches both results, so once a car has
// been met the phone is out of the picture entirely and the watch opens it
// alone with AES-GCM and HMAC.

import { BaseSideService } from '@zeppos/zml/base-side'

import { normaliseVin } from '../lib/app/vin.js'
import { generatePrivateKey, derivePublicKey, ecdh, isValidPrivateKey } from '../lib/crypto/p256.js'
import { fromHex, toHex } from '../lib/util/hex.js'

function readString (raw) {
  if (!raw) return ''
  try {
    return JSON.parse(raw) || ''
  } catch (e) {
    return ''
  }
}

// The side service runs inside whatever JS host the Zepp app provides: a
// Chromium renderer in the simulator, a WebView or a React Native engine on a
// real phone, possibly something Node-like. Those expose a secure generator in
// different places, under different names, or not at all -- and an earlier
// version of this probe reported "unavailable" purely because it only looked
// for the Web API. Giving up means the user cannot create a key at all, so
// every plausible source is tried.
//
// Returns { bytes, source } or null. Only genuinely cryptographic sources are
// considered; Math.random is deliberately not among them.
function secureRandomBytes (count) {
  // 1. Web Crypto, wherever it may be hiding.
  const webCandidates = []
  try { if (typeof globalThis !== 'undefined') webCandidates.push(globalThis.crypto) } catch (e) {}
  try { if (typeof crypto !== 'undefined') webCandidates.push(crypto) } catch (e) {}
  try { if (typeof window !== 'undefined') webCandidates.push(window.crypto, window.msCrypto) } catch (e) {}
  try { if (typeof self !== 'undefined') webCandidates.push(self.crypto) } catch (e) {}

  for (const candidate of webCandidates) {
    if (candidate && typeof candidate.getRandomValues === 'function') {
      try {
        const buffer = new Uint8Array(count)
        candidate.getRandomValues(buffer)
        return { bytes: buffer, source: 'getRandomValues' }
      } catch (e) {}
    }
  }

  // 2. A Node-style randomBytes, which some hosts expose instead. It is backed
  //    by the OS generator and is every bit as good.
  const nodeCandidates = []
  for (const candidate of webCandidates) {
    if (candidate && typeof candidate.randomBytes === 'function') nodeCandidates.push(candidate)
  }
  try {
    if (typeof globalThis !== 'undefined' && typeof globalThis.require === 'function') {
      nodeCandidates.push(globalThis.require('crypto'))
    }
  } catch (e) {}

  for (const candidate of nodeCandidates) {
    if (candidate && typeof candidate.randomBytes === 'function') {
      try {
        return { bytes: new Uint8Array(candidate.randomBytes(count)), source: 'randomBytes' }
      } catch (e) {}
    }
  }

  return null
}

// Rejection sampling needs a generator it can call repeatedly, and it must
// throw rather than quietly degrade if the source disappears mid-draw.
function drawSecureBytes (count) {
  const result = secureRandomBytes(count)
  if (!result) throw new Error('secure generator became unavailable')
  return result.bytes
}

// Records whether this phone can produce key-grade randomness, for the settings
// screen to display. Written on startup and again whenever the settings screen
// asks -- the screen has no way to find this out on its own, and until the
// service has run at least once there is simply nothing to show.
function reportEntropyCapability (service) {
  const probe = secureRandomBytes(1)
  const source = probe ? probe.source : 'none'

  service.log('secure randomness ' +
    (probe ? 'AVAILABLE via ' + source : 'NOT AVAILABLE, key creation will be refused'))

  settings.settingsStorage.setItem('entropySource', JSON.stringify(source))
  // A timestamp so the screen can show when this was last established, rather
  // than leaving a stale answer looking freshly checked.
  settings.settingsStorage.setItem('entropyCheckedAt', JSON.stringify(Date.now()))
}

AppSideService(
  BaseSideService({
    onInit () {
      reportEntropyCapability(this)
    },

    // Settings changes arrive here, and the hook matters more than it looks.
    //
    // This service is not running most of the time; editing a setting is itself
    // what starts it. A listener registered in onInit therefore misses the very
    // change that woke the service, because that change happened before any of
    // this code existed -- which is exactly the case of entering a VIN for the
    // first time. ZML replays it through this hook instead, using the launch
    // arguments, and also routes live changes here while the service happens to
    // already be up. Registering settingsStorage.addListener by hand only gets
    // the second kind, and silently loses the first.
    onSettingsChange (change) {
      // Live changes and replayed launch arguments have the same shape, but a
      // service woken for some other reason gets nothing at all.
      if (!change || !change.key) return
      const { key, newValue } = change

      if (key === 'vin') {
        const vin = normaliseVin(readString(newValue))
        // Written on every keystroke, so most of these are half a VIN.
        if (!vin) return
        this.log('forwarding vin to the watch')
        this.call({ method: 'SET_VIN', vin })
      } else if (key === 'forgetKey') {
        this.log('forwarding key reset to the watch')
        this.call({ method: 'FORGET_KEY' })
      } else if (key === 'autoUnlock') {
        this.call({ method: 'SET_AUTO_UNLOCK', enabled: newValue === 'true' || newValue === true })
      } else if (key === 'entropyProbeRequest') {
        // The settings screen asking to be told again. It cannot answer this
        // for itself: it runs in a different JS context, and it is this one
        // that actually supplies the entropy.
        reportEntropyCapability(this)
      }
    },

    // The watch asks for the VIN on startup, which covers the case where it was
    // set before the app was ever opened.
    onRequest (req, res) {
      if (req.method === 'GET_VIN') {
        // Half a VIN is stored on the way to a whole one, so answer with a
        // complete one or nothing. "Still being typed" and "answered" must not
        // look the same to the watch.
        const vin = normaliseVin(readString(settings.settingsStorage.getItem('vin')))
        this.log(vin ? 'answering the watch with the stored vin' : 'no complete vin stored yet')
        res(null, { vin: vin || '' })
        return
      }
      // GET_ENTROPY used to live here: raw randomness for the watch to build a
      // key from itself. Removed with the watch-side generation it fed. Handing
      // out entropy for that purpose again would only invite a caller to spend
      // ninety seconds turning it into a key, on the one machine that cannot
      // afford to.
      // Builds the watch's keypair here rather than on the watch.
      //
      // The elliptic-curve maths is identical either way, but this engine runs
      // it in about ten milliseconds where the watch's interpreter needs some
      // ninety seconds -- long enough that the watch could only ever show a
      // progress bar and hope the owner waited. The cost is that the private
      // key crosses the link once, at setup; it is generated, sent, and
      // forgotten here, never stored on this side.
      if (req.method === 'GET_KEYPAIR') {
        const probe = secureRandomBytes(1)
        if (!probe) {
          // Same refusal as for raw entropy: a key is only as good as the
          // generator behind it, and there is no acceptable fallback.
          this.log('keypair refused: no secure generator on this phone')
          res(null, { quality: 'unavailable', source: 'none' })
          return
        }

        try {
          const privateKey = generatePrivateKey(drawSecureBytes)
          const publicKey = derivePublicKey(privateKey)
          this.log('generated a keypair for the watch via ' + probe.source)
          res(null, {
            quality: 'strong',
            source: probe.source,
            privateHex: toHex(privateKey),
            publicHex: toHex(publicKey)
          })
        } catch (e) {
          // Nothing to fall back on: the watch cannot make its own. Reported so
          // it can say so plainly rather than leaving setup looking stalled.
          this.log('keypair generation failed: ' + e.message)
          res(null, { quality: 'failed', source: probe.source })
        }
        return
      }

      // The ECDH the watch cannot afford, for one vehicle.
      //
      // The private key comes back over the link to be used here and is not
      // kept, exactly as it was not kept when this side generated it. That is
      // the same single exposure the keypair already accepts rather than a new
      // one, and it buys the watch the ability to meet a car at all: the
      // alternative is 87 seconds of blocked interpreter inside a Bluetooth
      // callback, which resets the watch.
      //
      // Reached once per car. The watch caches the result and never asks again.
      if (req.method === 'DERIVE_SHARED_SECRET') {
        const privateKey = fromHex(req.privateHex || '')
        const vehiclePublicKey = fromHex(req.vehiclePublicHex || '')

        if (!privateKey || !isValidPrivateKey(privateKey)) {
          this.log('shared secret refused: the watch sent an unusable private key')
          res(null, { error: 'the watch sent an unusable private key' })
          return
        }
        if (!vehiclePublicKey || vehiclePublicKey.length !== 65) {
          this.log('shared secret refused: malformed vehicle public key')
          res(null, { error: 'the vehicle sent a malformed public key' })
          return
        }

        // Returns null for a point that is not on the curve, which is the check
        // that stops an invalid-curve attack from leaking the private key.
        const sharedX = ecdh(privateKey, vehiclePublicKey)
        if (!sharedX) {
          this.log('shared secret refused: vehicle public key is not on the curve')
          res(null, { error: 'the vehicle public key is not a valid curve point' })
          return
        }

        this.log('derived a shared secret for the watch')
        res(null, { sharedHex: toHex(sharedX) })
        return
      }

      if (req.method === 'REPORT_STATUS') {
        settings.settingsStorage.setItem('status', JSON.stringify(req.status || ''))
        res(null, { ok: true })
        return
      }
      res(null, {})
    },

    onRun () {},
    onDestroy () {}
  })
)
