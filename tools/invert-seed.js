// Tests whether the watch's Math.random() is seeded from its clock.
//
//   node tools/invert-seed.js <at-ms> <r1-hex> <r2-hex> [--window-seconds N]
//
// Read the three values off the watch's diagnostics screen (tap the title), or
// from its console line: "[freesla] launch sample at=... r1=... r2=...".
//
// QuickJS seeds xorshift64* once per context from gettimeofday microseconds and
// never reseeds, so the first outputs of Math.random() are a pure function of
// the launch time. This searches microsecond timestamps around the reported
// clock reading for one that reproduces both outputs exactly.
//
// A HIT is proof, not inference: every key becomes only as unguessable as the
// moment it was created, and an attacker holding the public key -- which the
// protocol broadcasts in the clear -- can run this same search. A MISS over a
// generous window shows the firmware does not seed this way; it does not prove
// the seed is strong.

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const MASK = (1n << 64n) - 1n
const MULTIPLIER = 0x2545f4914f6cdd1dn

// QuickJS: x ^= x >> 12; x ^= x << 25; x ^= x >> 27; state = x; return x * M
export function xorshift64star (state) {
  let x = state
  x ^= x >> 12n
  x &= MASK
  x ^= (x << 25n) & MASK
  x &= MASK
  x ^= x >> 27n
  x &= MASK
  return { state: x, output: (x * MULTIPLIER) & MASK }
}

// Math.random builds its double from the top 52 bits: u.d = 1.<52 bits>, minus 1.
export function mantissa (output) {
  return output >> 12n
}

// The two mantissas a QuickJS context seeded with `seed` would yield first.
export function expectedMantissas (seed) {
  const state = seed === 0n ? 1n : seed
  const first = xorshift64star(state)
  const second = xorshift64star(first.state)
  return { first: mantissa(first.output), second: mantissa(second.output) }
}

// Recovers the double Math.random() would have returned, for cross-checking.
export function mantissaToDouble (m) {
  return Number(m) / 4503599627370496
}

export function doubleToMantissa (value) {
  return BigInt(Math.round(value * 4503599627370496))
}

// Searches [from, to] inclusive. Returns the seed, or null.
export function search (from, to, target1, target2, onProgress) {
  let checked = 0

  for (let seed = from; seed <= to; seed++) {
    const state = seed === 0n ? 1n : seed
    const first = xorshift64star(state)

    if (mantissa(first.output) === target1) {
      // A 52-bit match is already decisive; confirming the second output
      // removes any doubt about a coincidence.
      const second = xorshift64star(first.state)
      if (mantissa(second.output) === target2) return seed
    }

    checked++
    if (onProgress && (checked & 0xfffff) === 0) onProgress(checked)
  }

  return null
}

function parseArgs (argv) {
  const positional = []
  let windowSeconds = 5

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--window-seconds') windowSeconds = Number(argv[++i])
    else positional.push(argv[i])
  }
  return { positional, windowSeconds }
}

function main () {
  const { positional, windowSeconds } = parseArgs(process.argv.slice(2))

  if (positional.length < 3) {
    console.error('usage: node tools/invert-seed.js <at-ms> <r1-hex> <r2-hex> [--window-seconds N]')
    console.error('')
    console.error('Take the values from the watch: tap the title on the main screen,')
    console.error('or read the "[freesla] launch sample" line from the console log.')
    process.exit(2)
  }

  const atMs = BigInt(positional[0])
  const target1 = BigInt('0x' + positional[1].replace(/^0x/, ''))
  const target2 = BigInt('0x' + positional[2].replace(/^0x/, ''))

  // The seed is drawn at context creation, slightly before the clock reading,
  // so the window looks further back than forward.
  const centre = atMs * 1000n
  const from = centre - BigInt(Math.round(windowSeconds * 1000000))
  const to = centre + 1000000n
  const total = to - from

  console.log('Searching ' + total.toLocaleString() + ' microsecond seeds')
  console.log('  clock reading   ' + atMs + ' ms')
  console.log('  window          -' + windowSeconds + 's .. +1s around it')
  console.log('  target r1       ' + target1.toString(16))
  console.log('  target r2       ' + target2.toString(16))
  console.log('')

  const started = Date.now()
  const hit = search(from, to, target1, target2, (checked) => {
    const pct = Number((BigInt(checked) * 100n) / total)
    process.stdout.write('\r  ' + pct + '%  (' + checked.toLocaleString() + ' checked)')
  })
  const elapsed = (Date.now() - started) / 1000
  process.stdout.write('\r' + ' '.repeat(60) + '\r')

  if (hit !== null) {
    console.log('\x1b[31mHIT\x1b[0m — the generator is seeded from the clock.')
    console.log('')
    console.log('  seed          ' + hit + ' microseconds')
    console.log('  which is      ' + new Date(Number(hit / 1000n)).toISOString())
    console.log('  offset        ' + (hit - centre) + ' us from the reported reading')
    console.log('  searched in   ' + elapsed.toFixed(1) + ' s')
    console.log('')
    console.log('This is proof, not inference. Every key generated on the watch is')
    console.log('determined by the moment it was made, and the public half travels')
    console.log('in the clear over BLE for anyone to check guesses against. Do not')
    console.log('enrol a watch-generated key; use the phone path, and delete any')
    console.log('key already added to the car.')
    process.exitCode = 1
    return
  }

  console.log('\x1b[32mNO MATCH\x1b[0m across ' + total.toLocaleString() +
    ' candidates in ' + elapsed.toFixed(1) + ' s.')
  console.log('')
  console.log('The generator is not seeded from this clock in the window searched.')
  console.log('Encouraging, but not a clean bill of health: it rules out this')
  console.log('specific seeding, not a small seed space in general. Widen with')
  console.log('--window-seconds before concluding, and keep generating keys with')
  console.log('the phone regardless.')
}

// Only run the CLI when invoked directly, so the logic stays importable by the
// tests. Comparing resolved paths rather than matching on the filename, which
// also matches the test module.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
