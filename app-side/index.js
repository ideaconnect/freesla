// Phone-side companion.
//
// Its only job is to carry the VIN from the settings screen to the watch,
// because settings storage lives on the phone and the watch cannot read it
// directly. Nothing here participates in the protocol -- once the VIN has
// arrived, the watch talks to the car alone, with the phone out of the picture.

import { BaseSideService } from '@zeppos/zml/base-side'

function readString (raw) {
  if (!raw) return ''
  try {
    return JSON.parse(raw) || ''
  } catch (e) {
    return ''
  }
}

const HEX = '0123456789abcdef'

function toHex (bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[(bytes[i] >>> 4) & 0x0f] + HEX[bytes[i] & 0x0f]
  }
  return out
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

function secureGenerator () {
  return secureRandomBytes(1) ? true : null
}

// Returns { hex, quality } on success, or { quality: 'unavailable' } when this
// phone has no cryptographically secure generator.
//
// No weak fallback is offered. The watch refuses to build a key from anything
// less, so returning Math.random output here would only invite it to be used.
// Reporting the failure instead lets the watch tell the owner what is actually
// wrong, which is a different problem from the phone being out of range.
function collectPhoneEntropy (byteCount) {
  const count = Math.max(16, Math.min(128, byteCount | 0))
  const result = secureRandomBytes(count)
  if (!result) return { quality: 'unavailable', source: 'none' }
  return { hex: toHex(result.bytes), quality: 'strong', source: result.source }
}

// Records whether this phone can produce key-grade randomness, for the settings
// screen to display. Written on startup and again whenever the settings screen
// asks -- the screen has no way to find this out on its own, and until the
// service has run at least once there is simply nothing to show.
function reportEntropyCapability (service) {
  const probe = secureRandomBytes(1)
  const source = probe ? probe.source : 'none'

  service.log('secure randomness ' +
    (probe ? 'AVAILABLE via ' + source : 'NOT AVAILABLE — key creation will be refused'))

  settings.settingsStorage.setItem('entropySource', JSON.stringify(source))
  // A timestamp so the screen can show when this was last established, rather
  // than leaving a stale answer looking freshly checked.
  settings.settingsStorage.setItem('entropyCheckedAt', JSON.stringify(Date.now()))
}

AppSideService(
  BaseSideService({
    onInit () {
      reportEntropyCapability(this)

      settings.settingsStorage.addListener('change', ({ key, newValue }) => {
        if (key === 'vin') {
          const vin = readString(newValue)
          if (vin.length !== 17) return
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
      })
    },

    // The watch asks for the VIN on startup, which covers the case where it was
    // set before the app was ever opened.
    onRequest (req, res) {
      if (req.method === 'GET_VIN') {
        res(null, { vin: readString(settings.settingsStorage.getItem('vin')) })
        return
      }
      if (req.method === 'GET_ENTROPY') {
        // The watch has no cryptographically secure generator. The phone very
        // likely does, and a private key is the one secret worth crossing the
        // link for. It is sent once, at setup, and mixed with watch-side
        // entropy rather than used alone -- so this side being weak, or the
        // watch side being weak, is not on its own enough to weaken the key.
        const entropy = collectPhoneEntropy(req.bytes || 48)
        this.log('supplying ' + entropy.quality + ' entropy to the watch')
        res(null, entropy)
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
