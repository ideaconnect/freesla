# Freesla

A Bluetooth key for Tesla vehicles that runs on a Zepp OS watch (built for the
Amazfit T-Rex 3 Pro). The watch talks to the car directly over BLE — no phone,
no network, no account.

Made by **[IDCT](https://idct.tech)**. Free and open source at
**[github.com/ideaconnect/freesla](https://github.com/ideaconnect/freesla)**.

Not affiliated with, endorsed by, or sponsored by Tesla, Inc.

## Security model — read this first

A Tesla phone key is only useful once **the owner has enrolled its public key in
the car**, and the only way to do that is to tap an already-enrolled NFC keycard
on the centre console. This app generates its own P-256 keypair on the watch and
asks to be enrolled; until someone with physical possession of a valid keycard
approves it, the key is inert.

That is the same position a legitimate phone key is in. Building this client
gives you no way into a car you cannot already open — much as writing an SSH
client gives you no access to servers your key is not on. The protocol itself is
published by Tesla in the [`vehicle-command`](https://github.com/teslamotors/vehicle-command)
SDK, which exists precisely so third parties can build integrations.

The private key is generated on the watch and never leaves it. Uninstalling the
app destroys it; revoke the corresponding entry from the Tesla app afterwards.

## Status

| Area | State |
|---|---|
| Protocol implementation | Verified byte-for-byte against Tesla's published test vectors |
| Cryptography | Verified against OpenSSL (Node `crypto`) |
| End-to-end flow | Verified against a mock vehicle, including over fragmented BLE |
| App bundle | Compiles to a `.zab` with the official `zeus` toolchain |
| **Real vehicle** | **Not tested — no car was available** |
| **Real watch BLE** | **Not tested — the Zepp simulator has no Bluetooth** |

The last two rows are the honest gap. Everything testable without hardware has
been tested; the BLE transport in particular is written from Zepp's API surface
and Zepp's own `easy-ble` library, and has never run on a wrist.

## Setup

1. Enter your VIN in the app's settings page in the Zepp phone app. This is the
   only configuration there is — the VIN determines the BLE name the car
   advertises under and is bound into every command signature, so it cannot be
   discovered automatically.
2. Open Freesla on the watch and tap **Create key**. This takes a few seconds.
3. Stand next to the car, tap **Add to car**, then tap an existing keycard on
   the centre console when the car asks.

After that the watch is standalone. The phone is never needed again.

### Controls

The main screen keeps only lock and unlock — those are what you reach for
walking to the car. Everything that physically moves a panel lives one tap away
behind **Controls**:

| Control | Field | Confirm | Works on |
|---|---|---|---|
| Trunk open | 5 | no | every model; pops the latch even without a powered liftgate |
| Trunk close | 5 | yes | powered liftgate only — silently ignored otherwise |
| Trunk stop | 5 | no | halts a moving panel |
| Frunk open | 6 | yes | every model — **cannot be closed remotely on any Tesla** |
| Doors open | 1–4 | yes | unlatches on Model 3/Y; a Model X swings them |
| Charge port | 7 | no | every model |

Doors are sent as **four separate single-field messages**, not one multi-field
request. The protobuf permits several fields at once, but Tesla's SDK builds
these from a switch that emits exactly one field, so a multi-field
`ClosureMoveRequest` has never been on the wire from Tesla's own tooling.

### What is deliberately missing

**Doors close** and **frunk close** are not implemented, and shouldn't be. Only a
Model X can pull a door shut, and there the panel is a falcon wing whose
obstruction detection Tesla's manual explicitly declines to promise; on every
other model the command is inert. No Tesla can close a frunk remotely at all —
the bonnet needs a deliberate two-handed press. A button for either would be a
no-op on almost every car and unsafe on the rest.

### Why some controls ask twice

A closure needs confirmation if it is irreversible from the watch, or drives a
panel toward where a person might be. Opening the boot is neither, so it stays a
single tap. Opening the frunk asks first — not because it is dangerous, but
because nothing can undo it remotely. Stop never asks: a confirmation on an abort
control is an anti-feature.

### "Sent" never means "done"

VCSEC acknowledges a command with silence, which proves the message was accepted,
not that a motor turned. A car ignores closures it has no hardware for without
complaining. So the UI says *sent*, and never claims the panel moved.

### Unlock on approach

Optional, off by default, toggled in the phone settings. With Freesla open on the
watch, the car unlocks as you walk up — no button press. It fires once per
approach and re-arms only after the car has gone out of range, and it ignores a
car that is merely in radio range rather than next to you (an RSSI floor,
default −70 dBm ≈ a few metres). Raise or lower it if it triggers too eagerly or
not eagerly enough.

## Why this was hard

Zepp OS provides **no cryptography whatsoever** — no ECDH, no AES-GCM, no
secure random. Everything the protocol needs had to be written in JavaScript,
under three constraints that ruled out every off-the-shelf library:

- **No BigInt.** The bundled `qjsc` rejects `1n` outright, so 256-bit modular
  arithmetic uses 16 × 16-bit limbs, where a full multiply column stays under
  2^53 and a double represents it exactly. Montgomery multiplication throughout.
- **No `async`/`await`.** Officially unsupported on-device and it hangs the app
  rather than failing, so the protocol client is callback-driven.
- **No JIT.** QuickJS 2020-07-05, a pure interpreter.

The elliptic-curve work is the only slow part, and it is arranged to happen
almost never. The ECDH shared secret depends only on our private key and the
vehicle's, so it is computed once and cached in watch storage; every unlock
afterwards costs one AES-GCM encryption of about a hundred bytes. Key
generation is a one-time cost at setup.

Scalar multiplication runs in ~9 ms on a desktop. Even at a 100× interpreter
penalty that stays well under a second, and it is off the unlock path entirely.

## Layout

### Screens

| Screen | Reached by | Holds |
|---|---|---|
| Main | app launch | status, Unlock, Lock, Controls |
| Controls | Controls button | trunk, frunk, doors, lock, charge port, stop |
| About | tapping the title | IDCT mark, links, licensing, way in to diagnostics |
| Diagnostics | About → Randomness check | the seed check and platform probes |

Artwork is generated by `node tools/make-icons.js` — Font Awesome glyphs for the
controls and the IDCT mark for the About screen, recoloured white for the
watch's dark interface. Zepp OS has no vector drawing and no icon font, so every
glyph is a bitmap baked at build time. The phone settings screen has no asset
pipeline at all, so its images are emitted as inline data URIs into
`setting/assets.js`. See [ATTRIBUTION.md](ATTRIBUTION.md).

```
lib/crypto/     SHA-1, SHA-256/HMAC, AES, GCM, P-256, RNG   (portable, no platform deps)
lib/tesla/      protobuf, framing, metadata, session, messages, client
lib/zepp/       BLE transport and storage                    (imports @zos/*)
lib/app/        identity and the UI state machine
page/           watch UI
setting/        phone settings page (VIN entry)
app-side/       phone companion — relays the VIN, nothing more
tools/          mock vehicle, simulated BLE link, verification script
```

The protocol client talks to an abstract link with `send` and `onMessage`. On
the watch that is BLE; under test it is the mock vehicle. Identical client code
runs on both.

## Testing

```
npm test              # 72 tests
node tools/verify.js  # narrated end-to-end run against the mock vehicle
```

Three things make the tests meaningful rather than self-confirming:

- **Tesla's own test vectors.** The metadata encoding, session-key derivation,
  GCM parameters and a complete 181-byte signed unlock message are all
  reproduced byte-for-byte from the published spec.
- **A different crypto implementation on the other side.** The mock vehicle runs
  every cryptographic operation through OpenSSL, and encodes signature metadata
  independently. A bug in our P-256, AES-GCM or TLV layout shows up as a
  mismatch instead of cancelling out.
- **Real fragmentation.** `tools/ble-link.js` splits traffic into 20-byte writes
  and reassembles from the length prefix, so the framing runs the same path it
  will on a GATT link.

The mock also enforces what a real car enforces — whitelist membership, epoch,
strictly increasing counters, expiry — so rejection paths are covered, including
recovery after the car reboots and rotates its epoch.

## Randomness, and why it matters more than the curve maths

Zepp OS provides no cryptographically secure random generator — only
`Math.random()`, which QuickJS seeds once per runtime. That is the weakest link
here, and it is worth being precise about why.

Your **public key travels in the clear** over BLE in every signed command. Anyone
standing near the car can capture it. That hands an attacker a perfect offline
oracle: guess a seed, derive the private key, derive the public key, compare. A
match is a working car key. Weak seeding is therefore not a theoretical concern
— it is directly exploitable by anyone who can read a BLE advertisement.

There is a specific reason to think the seed is very weak. QuickJS 2020-07-05 —
the engine Zepp ships — seeds `Math.random` **once per JS context, from a single
`gettimeofday` microsecond reading**, and never reseeds. If that is what this
firmware does, then every `Math.random()` output in a run is a pure function of
one number: when the app was launched. Hashing thirty-two of them together adds
nothing, because they are all the same number in disguise.

That has not been confirmed on this watch. It was verified in upstream QuickJS
source, not in Zepp's firmware binary, and Zepp could have patched it. Reviewers
put the odds of the stock behaviour at roughly 70–85%. **So measure it rather
than assume it** — see below.

Three things are done about it:

- **The phone's generator is required, not merely preferred.** At key creation
  the watch asks the phone companion for 48 bytes from `crypto.getRandomValues`.
  The seed becomes `SHA-256(phone entropy ‖ watch entropy)`, so an attacker must
  defeat both; neither being weak is sufficient alone. If no strong source
  answers, **generation is refused** rather than quietly producing a guessable
  key. There is an explicit override in settings for testing, and it says what
  it costs.
- **BLE scan observations are mixed in.** Nearby device addresses and their
  signal strengths are the least predictable thing the watch can see unaided.
  (This was wired up late — an earlier version collected them and then never
  passed them to the generator.)
- **A diagnostics screen measures the real behaviour.** Tap the title on the
  main screen.

### Run the randomness check first

Tap **Freesla** on the main screen, then close the app completely and reopen it
and look again. The second reading is the one that counts:

| Verdict | Meaning |
|---|---|
| `Baseline saved` | First run. Restart the app and look again. |
| `FIXED SEED` | The generator restarts identically every launch. **Do not enrol a key.** |
| `Seed space small` | A previous sample reappeared. Treat any key as weak. |
| `Seed varies` | The seed is not constant. Necessary, but it does **not** prove the seed is hard to guess. |

The same screen reports whether a secure RNG or BigInt exists, how many distinct
clock deltas a jitter loop produces, and how long a P-256 scalar multiplication
takes on your watch. All of it is also written to the console log.

Be careful reading `Seed varies`: it is exactly what clock seeding looks like.
The timestamp differs every launch, so the samples differ, and the cross-restart
check passes while the key remains guessable. That is why the next test exists.

### Prove it, don't infer it

The diagnostics screen also shows a **seed check** line — a millisecond clock
reading and the first two `Math.random()` outputs of that launch, captured in
`app.js` before anything else can touch the generator. Feed them to:

```
node tools/invert-seed.js <at-ms> <r1-hex> <r2-hex>
```

This searches microsecond timestamps for one whose xorshift64\* stream
reproduces both outputs. A **HIT is proof** that the generator is clock-seeded
and that every watch-generated key is only as unguessable as the moment it was
made — an attacker with your public key runs the same search against it. Finding
a known seed among 3 million candidates takes about 0.2 s.

A **NO MATCH** over a generous window shows the firmware does not seed this way.
That is encouraging, not a clean bill of health: it rules out this particular
seeding, not a small seed space in general.

## Known gaps

- **Randomness is the weak point — see below.** This is the most serious open
  issue in the project and the one to satisfy yourself about before enrolling
  a key.
- **Auto-unlock needs the app open.** Walk-up unlock with no button press works
  and is implemented, but only while Freesla is on screen: Zepp OS cannot run
  BLE central from a background service and closes a foreground app about ten
  seconds after the screen dims. Truly pocketable passive entry is not possible
  on this platform.
- **One connection at a time**, and only the VCSEC domain (lock, unlock, trunk,
  frunk, wake) is implemented. Climate and charging live in the infotainment
  domain and would need a second session.
- The BLE transport works around two documented-API defects: the `mstOn*`
  callbacks deliver a single object rather than positional arguments, and
  `mstBuildProfile` must follow `mstOnPrepare` with a short delay. Both come
  from Zepp's own library rather than their docs.
