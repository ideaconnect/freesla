// Random byte generation.
//
// Zepp OS ships no CSPRNG. There is only Math.random(), which is a seeded PRNG
// and completely unfit for choosing a private key. The private key is the one
// secret that matters here, so the app prefers to generate it where real
// randomness exists (the phone's crypto.getRandomValues during setup) and
// treats the watch-side pool below as a fallback.
//
// The fallback is a SHA-256 DRBG over whatever independent entropy the watch
// can offer: clock jitter, Math.random state, and any sensor readings the
// caller supplies. Hashing cannot create entropy, only spread what it is given,
// so callers should feed as many genuinely varying sources as they can.

import { sha256 } from './sha256.js'

function numberToBytes (value) {
  const out = new Uint8Array(8)
  let v = Math.abs(value)
  for (let i = 7; i >= 0; i--) {
    out[i] = v & 0xff
    v = Math.floor(v / 256)
  }
  return out
}

function concat (chunks) {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

// Samples the scheduler's timing noise. Only the clock deltas are folded in:
// an earlier version also mixed a checksum of the spin accumulator, but the
// loop bound cycles through seven values, so that checksum was seven IEEE-754
// constants contributing exactly zero bits while making the pool look richer
// than it was.
//
// Even the deltas are worth little on a device whose clock ticks in
// milliseconds; treat this as a garnish on real entropy, never as a source.
function collectTimingJitter (rounds) {
  const samples = []
  let previous = Date.now()
  for (let i = 0; i < rounds; i++) {
    let spin = 0
    const target = 200 + (i % 7) * 50
    for (let j = 0; j < target; j++) spin += Math.sqrt(j + 1)
    if (spin < 0) return concat(samples)

    const now = Date.now()
    samples.push(numberToBytes(now - previous))
    previous = now
  }
  return concat(samples)
}

function collectMathRandom (count) {
  const out = new Uint8Array(count * 8)
  for (let i = 0; i < count; i++) {
    out.set(numberToBytes(Math.floor(Math.random() * 9007199254740991)), i * 8)
  }
  return out
}

// Gathers a best-effort seed on the watch. `extraSources` should return
// Uint8Arrays or numbers from anything that varies: sensor readings, battery
// level, step count, uptime.
export function collectWatchEntropy (extraSources) {
  const chunks = [
    numberToBytes(Date.now()),
    collectMathRandom(32),
    collectTimingJitter(24)
  ]

  if (extraSources) {
    for (const source of extraSources) {
      try {
        const value = typeof source === 'function' ? source() : source
        if (value === undefined || value === null) continue
        chunks.push(typeof value === 'number' ? numberToBytes(value) : value)
      } catch (e) {
        // A missing sensor must not stop key generation.
      }
    }
  }

  chunks.push(numberToBytes(Date.now()))
  return concat(chunks)
}

// SHA-256 counter-mode DRBG. Deterministic given the seed, which keeps it
// testable; unpredictability rests entirely on the seed's quality.
export function createDrbg (seed) {
  const state = sha256(seed)
  let counter = 0

  return function randomBytes (n) {
    const out = new Uint8Array(n)
    let off = 0
    while (off < n) {
      const input = new Uint8Array(state.length + 8)
      input.set(state)
      input.set(numberToBytes(counter++), state.length)
      const block = sha256(input)
      const take = Math.min(32, n - off)
      out.set(block.subarray(0, take), off)
      off += take
    }
    return out
  }
}

// Picks the strongest generator available in the current environment. Returns
// { randomBytes, quality } where quality is 'strong' when it came from a real
// CSPRNG and 'weak' when it is the watch entropy pool.
export function createRandomSource (extraSources) {
  if (typeof globalThis !== 'undefined' &&
      globalThis.crypto &&
      typeof globalThis.crypto.getRandomValues === 'function') {
    return {
      quality: 'strong',
      randomBytes (n) {
        return globalThis.crypto.getRandomValues(new Uint8Array(n))
      }
    }
  }

  return {
    quality: 'weak',
    randomBytes: createDrbg(collectWatchEntropy(extraSources))
  }
}
