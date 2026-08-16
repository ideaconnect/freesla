// The probe's job is to catch a catastrophic condition — a generator that
// restarts from the same seed every launch — so its detection logic is tested
// against simulated generators of known behaviour.

import { test } from 'node:test'
import assert from 'node:assert'

import {
  probeRandomness, measureClockJitter, probeCapabilities, resetProbe, VERDICT
} from '../lib/app/rng-probe.js'
import { createMemoryBackend } from '../lib/app/settings-store.js'

// A generator that produces the same sequence from the same seed, the failure
// mode being screened for.
function seededRandom (seed) {
  let state = seed >>> 0
  return function () {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

test('the first run records a baseline and asks for a restart', () => {
  const backend = createMemoryBackend()
  const report = probeRandomness(backend, seededRandom(42))

  assert.strictEqual(report.verdict, VERDICT.BASELINE)
  assert.strictEqual(report.runs, 1)
  assert.ok(report.message.indexOf('reopen') >= 0, 'no instruction to restart')
})

test('an identical sequence across restarts is reported as a fixed seed', () => {
  const backend = createMemoryBackend()

  probeRandomness(backend, seededRandom(42))
  // Same seed again models a runtime that reseeds identically every launch.
  const second = probeRandomness(backend, seededRandom(42))

  assert.strictEqual(second.verdict, VERDICT.FIXED_SEED)
  assert.ok(second.message.indexOf('Do not enrol') >= 0, 'failed to warn against enrolling')
  assert.strictEqual(second.runs, 2)
})

test('a differing sequence is reported as varying but not declared safe', () => {
  const backend = createMemoryBackend()

  probeRandomness(backend, seededRandom(1))
  const second = probeRandomness(backend, seededRandom(2))

  assert.strictEqual(second.verdict, VERDICT.VARYING)
  // The distinction matters: varying is necessary, not sufficient.
  assert.ok(second.message.indexOf('does not prove') >= 0,
    'overclaimed safety: ' + second.message)
})

test('a seed drawn from a small space is caught as suspicious', () => {
  const backend = createMemoryBackend()

  // Three seeds cycling models a low-resolution clock: values vary run to run
  // yet the space is tiny.
  probeRandomness(backend, seededRandom(1))
  probeRandomness(backend, seededRandom(2))
  probeRandomness(backend, seededRandom(3))
  const repeat = probeRandomness(backend, seededRandom(1))

  assert.strictEqual(repeat.verdict, VERDICT.SUSPICIOUS)
  assert.ok(repeat.message.indexOf('small') >= 0)
})

test('history is bounded so the probe cannot grow without limit', () => {
  const backend = createMemoryBackend()
  for (let i = 0; i < 30; i++) probeRandomness(backend, seededRandom(i + 1))

  const stored = backend.getItem('freesla.probe.history', '')
  assert.ok(stored.split(';').length <= 6, 'probe history grew unbounded')
})

test('resetting clears the recorded baseline', () => {
  const backend = createMemoryBackend()
  probeRandomness(backend, seededRandom(7))
  resetProbe(backend)

  const fresh = probeRandomness(backend, seededRandom(7))
  assert.strictEqual(fresh.verdict, VERDICT.BASELINE, 'reset did not clear state')
})

test('clock jitter measurement reports distinct deltas', () => {
  const jitter = measureClockJitter(() => Date.now(), 24)

  assert.ok(jitter, 'measurement returned nothing')
  assert.strictEqual(jitter.rounds, 24)
  assert.ok(jitter.distinctDeltas >= 1)
  assert.ok(jitter.optimisticBitsPerSample >= 0)
})

test('a frozen clock is correctly reported as contributing nothing', () => {
  // The worst case a watch could present: a clock too coarse to move at all
  // during the loop, making every delta zero.
  const jitter = measureClockJitter(() => 1000, 16)

  assert.strictEqual(jitter.distinctDeltas, 1)
  assert.strictEqual(jitter.zeroDeltas, 16)
  assert.strictEqual(jitter.optimisticBitsPerSample, 0,
    'a frozen clock must be credited with zero entropy')
})

test('capability probe reports the platform honestly', () => {
  const caps = probeCapabilities()

  assert.strictEqual(typeof caps.bigint, 'boolean')
  assert.strictEqual(typeof caps.webCrypto, 'boolean')
  assert.strictEqual(caps.typedArrays, true)
  // Under Node these are present; on the watch they are expected to be false,
  // which is the entire point of running the probe there.
  assert.strictEqual(caps.webCrypto, true, 'node should expose webcrypto')
})
