// Measures how unpredictable this device's randomness actually is.
//
// Everything about the key's strength rests on one question that no amount of
// documentation can settle: is Math.random() seeded differently each time the
// app starts? QuickJS seeds its generator at runtime creation, and if that seed
// derives only from a coarse clock, or worse is constant, then the private
// key is guessable by anyone who captures the public key, which travels in the
// clear over BLE in every command.
//
// So the app records its first samples and compares them on later runs. A
// repeat across restarts is catastrophic and must be reported as such.

const SAMPLE_KEY = 'freesla.probe.sample'
const RUNS_KEY = 'freesla.probe.runs'
const HISTORY_KEY = 'freesla.probe.history'

const SAMPLE_COUNT = 8
const HISTORY_LIMIT = 6

export const VERDICT = {
  BASELINE: 'baseline',
  FIXED_SEED: 'fixed-seed',
  VARYING: 'varying',
  SUSPICIOUS: 'suspicious'
}

function sampleRandom (random, count) {
  const parts = []
  for (let i = 0; i < count; i++) {
    // Twelve hex digits keeps roughly 48 bits per sample, enough to make an
    // accidental collision meaningless while staying short enough to store.
    parts.push(Math.floor(random() * 281474976710655).toString(16))
  }
  return parts.join(',')
}

// Counts distinct gaps between successive clock readings across a busy loop.
// A clock that only ever reports the same delta contributes no entropy at all,
// however many rounds are run.
export function measureClockJitter (now, rounds) {
  const deltas = {}
  let distinct = 0
  let previous = now()
  let zeroDeltas = 0

  for (let i = 0; i < rounds; i++) {
    let spin = 0
    for (let j = 0; j < 400; j++) spin += Math.sqrt(j + 1)
    // Keep the accumulator observable so the loop cannot be optimised away.
    if (spin < 0) return null

    const current = now()
    const delta = current - previous
    previous = current

    if (delta === 0) zeroDeltas++
    const label = String(delta)
    if (!deltas[label]) {
      deltas[label] = 0
      distinct++
    }
    deltas[label]++
  }

  return {
    rounds,
    distinctDeltas: distinct,
    zeroDeltas,
    // log2 of the distinct-value count is a generous ceiling on per-sample
    // entropy: real entropy is lower because the values are not uniform.
    optimisticBitsPerSample: distinct > 1 ? Math.log(distinct) / Math.LN2 : 0,
    distribution: deltas
  }
}

// Runs the cross-restart comparison. `backend` is the settings key-value store.
export function probeRandomness (backend, random) {
  const sample = sampleRandom(random, SAMPLE_COUNT)
  const previous = backend.getItem(SAMPLE_KEY, '')
  const runs = parseInt(backend.getItem(RUNS_KEY, '0'), 10) || 0

  let history = backend.getItem(HISTORY_KEY, '')
  const historyList = history ? history.split(';') : []

  const nextRuns = runs + 1
  backend.setItem(RUNS_KEY, String(nextRuns))

  let verdict
  let message

  // Whether this device has EVER produced two different samples. A repeat means
  // something quite different depending on the answer: with no variation ever
  // seen the seed is simply constant, whereas a repeat after genuine variation
  // means the seed space is small enough to cycle.
  const everVaried = uniqueCount(historyList) > 1
  const seenBefore = sample === previous || historyList.indexOf(sample) >= 0

  if (!previous) {
    backend.setItem(SAMPLE_KEY, sample)
    verdict = VERDICT.BASELINE
    message = 'Baseline recorded. Close the app fully, reopen it, and check again.'
  } else if (sample === previous && !everVaried) {
    verdict = VERDICT.FIXED_SEED
    message = 'Math.random repeated exactly across restarts. The generator is ' +
      'seeded identically every launch, so a key generated from it is guessable. ' +
      'Do not enrol a key from this source.'
  } else if (seenBefore) {
    verdict = VERDICT.SUSPICIOUS
    message = 'A previously seen sample reappeared, so the seed space looks small ' +
      'enough to search. Treat a key generated from it as weak.'
  } else {
    // Variation is necessary but not sufficient: a seed taken from a coarse
    // clock varies every run yet stays well within brute-force range.
    verdict = VERDICT.VARYING
    message = 'Sample differs from previous runs, so the seed is not constant. ' +
      'This does not prove the seed is hard to guess.'
  }

  historyList.push(sample)
  while (historyList.length > HISTORY_LIMIT) historyList.shift()
  backend.setItem(HISTORY_KEY, historyList.join(';'))

  return {
    verdict,
    message,
    runs: nextRuns,
    sample,
    previous,
    distinctRunsRecorded: uniqueCount(historyList)
  }
}

function uniqueCount (list) {
  const seen = {}
  let count = 0
  for (const item of list) {
    if (!seen[item]) {
      seen[item] = true
      count++
    }
  }
  return count
}

// Whether the platform offers the pieces a strong key would need.
export function probeCapabilities () {
  const report = {}

  report.bigint = typeof BigInt !== 'undefined'
  report.typedArrays = typeof Uint8Array !== 'undefined' && typeof DataView !== 'undefined'
  report.promise = typeof Promise !== 'undefined'

  // The one that matters: any real CSPRNG reachable from device code.
  report.webCrypto = typeof globalThis !== 'undefined' &&
    !!globalThis.crypto &&
    typeof globalThis.crypto.getRandomValues === 'function'

  return report
}

// Captures the very first outputs of Math.random() in this JS context, together
// with the wall clock, so the seeding can be tested rather than assumed.
//
// QuickJS seeds its generator once per context from a microsecond clock reading
// and never reseeds. If that is what this firmware does, then these outputs are
// a pure function of the launch time, and tools/invert-seed.js will find the
// exact microsecond that produces them. A hit proves the key material is only
// as unguessable as the moment it was made.
//
// Must run before anything else touches Math.random, hence its call at the top
// of app.js.
export function captureLaunchSample () {
  const first = Math.random()
  const second = Math.random()
  const at = Date.now()

  return {
    at,
    first,
    second,
    // Doubles from Math.random are exactly k / 2^52, so this recovers k with no
    // rounding error and gives the tool something exact to match against.
    firstMantissa: mantissaOf(first),
    secondMantissa: mantissaOf(second)
  }
}

function mantissaOf (value) {
  return Math.round(value * 4503599627370496).toString(16)
}

export function resetProbe (backend) {
  backend.removeItem(SAMPLE_KEY)
  backend.removeItem(RUNS_KEY)
  backend.removeItem(HISTORY_KEY)
}
