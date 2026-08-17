# teslamock: a computer pretending to be a Tesla

A command-line program that answers to Tesla's vehicle protocol, so a key can be
developed and tested without borrowing a car. It speaks the real thing: ECDH
over P-256, the SHA-1 session key, AES-GCM with Tesla's TLV signature metadata,
epochs, counters, expiry, the whitelist, and the NFC keycard tap that guards it.

It serves two transports:

| | What it is | What it is good for |
|---|---|---|
| **Bluetooth** | a real GATT server carrying Tesla's vehicle service, advertised as a connectable peripheral | the watch's scan, connect, MTU and fragmentation path, everything the Zepp simulator cannot do, because it has no radio |
| **TCP** | the same car on `127.0.0.1:7070`, framed and fragmented into 20-byte writes exactly as a GATT link would be | the protocol itself, in CI, from a script, on any machine, with no Bluetooth at all |

Both run at once by default. Replies go back the way the request came, so a
watch on Bluetooth and a test script on the socket can be served in turn.

## Build and run

```
dotnet build mock-car                     # produces mock-car/bin/…/teslamock.exe
dotnet run --project mock-car -- --help
```

.NET 8 or newer, Windows 10 build 19041 or newer. Windows because the BLE
peripheral role is reachable only through WinRT. There is no other way for a
Windows program to be a GATT server. Nothing below the transport layer touches
WinRT, so the protocol half is ordinary portable C#.

```
teslamock --vin 5YJ30123456789ABC         # be that car, on Bluetooth and TCP
teslamock --no-ble --tcp 7070             # protocol only, no radio
teslamock doctor                          # can this machine be a peripheral at all?
teslamock name                            # what a scanner sees, and how to be found
```

## The one thing Windows will not do

A Tesla is found by name. The watch derives `S<16 hex>C` from the VIN, scans for
exactly that, and ignores everything else, so a mock that advertises under any
other name is invisible no matter how correct its GATT server is.

**Windows does not let a program choose the name in its own advertisements.**
This is not a gap in this program; it was measured on the radio in front of it:

| What an app tries to advertise | Legacy | Extended |
|---|---|---|
| `LocalName` property | throws | throws |
| `0x09` complete local name section | unauthorized | unauthorized |
| `0x08` shortened local name section | unauthorized | unauthorized |
| `0xFF` manufacturer-specific data | **works** | **works** |

Manufacturer data is the only section an app may write. The name that goes out
belongs to the Bluetooth radio, and the radio's name lives in a registry key
owned by SYSTEM.

So the mock does not try to be called something it cannot be called. It
advertises under whatever name this machine has, says so on startup, and prints
the one line that makes a watch look for that name instead.

**1. Point the watch at this machine.** The name the app scans for is a
build-time setting in `freesla.config.js` at the root of this repository:

```js
export const BLE_NAME_OVERRIDE = 'DESKTOP-4F2A'
```

`teslamock doctor`, or the mock's own startup output, prints that line with
this machine's real name already in it, so it is a copy and a paste. Build the
app, and its scan matches the mock instead of a VIN-derived name.

Nothing on the machine changes, nothing needs Administrator, and nothing has to
be put back. **What does have to be put back is the setting**: a build carrying
an override looks for that name and nothing else, so it cannot find a real
Tesla, and on the watch that is indistinguishable from a car out of range.
Empty it again before building for a car. `node tools/verify.js` says so loudly
if you forget.

Two things this does *not* change:

- **The VIN still has to match.** The name decides which advertisement the watch
  connects to; the VIN is signed into every command. Pair the watch to the same
  VIN the mock is running (`--vin`), or the link comes up and everything sent
  over it is rejected, which reads as a protocol fault rather than a setting.
- **The name reported here is a prediction, not an observation.** Windows cannot
  scan its own advertisements, so the mock reports the radio's configured name;
  what actually goes out could differ, most plausibly by being shortened to fit
  a 31-byte advertisement alongside a 128-bit service UUID. If the watch still
  finds nothing, its log names every advertisement it *did* see while scanning,
  use that name. nRF Connect on a phone shows the same thing from outside.

**2. Change the radio's name.** The other direction, when you would rather have
one build that works with both. From an Administrator prompt:

```
teslamock name --set --vin <VIN>          # writes it as SYSTEM, then restarts the radio
teslamock doctor                          # confirm what is now in the air
teslamock name --restore                  # put your machine's own name back
```

The write itself goes through a one-shot scheduled task running as SYSTEM,
because an Administrator is not SYSTEM and this key belongs to the latter. This
changes the name your machine advertises to everything, not only to a watch,
until you restore it. If the change does not show up, disable and re-enable the
Bluetooth adapter in Device Manager, or reboot, and check with `doctor` again.

**3. Test over TCP.** Everything except scan-by-name is identical: same framing,
same 20-byte fragments, same protocol, same rejections. This is what
`tools/verify-mock-car.js` uses, and it needs no Bluetooth, no elevation and no
hardware.

**4. Run the peripheral on Linux.** BlueZ lets an application set the advertised
name freely, so a Raspberry Pi or any Linux box has none of this trouble. This
program does not implement a BlueZ backend (the WinRT one is what a Windows
desktop needs) but the protocol core is portable if you want one.

## When the watch restarts instead of connecting

A Zepp watch that trips its watchdog does not report a fault, it reboots. Every
JavaScript-side log dies with it, so the car is the only witness that survives,
and `-v` is what makes its account good enough to convict.

```
teslamock -v                    # every GATT operation, with sizes and timing deltas
teslamock --trace               # the above, with the bytes
teslamock -v --silence-every 1  # say so every second while the key is quiet
```

Three things change under `-v`, each aimed at this fault:

**Every line carries a delta.** `0.019 + 0.019` is seconds since the car started
and seconds since the previous line. A watch that stalls does not announce it; it
stops, and the gap is the only evidence there is.

**Fragments are announced before they are written**, not after. A burst that dies
halfway names the fragment it died on. A line written after the send can only
ever name a fragment that already went, which is the one thing you knew.

**Silence is reported out loud.** Every other line in the program exists because
something arrived, so the failure being investigated is exactly the case where
the log goes blank. A timer says so instead, and names what the key was last
sent.

### Reading it

The car sees a fixed sequence, and where it stops is which watch-side step to
suspect. What follows is the last line before the gap:

| The trace stops after | The watch died | Which means it was doing |
|---|---|---|
| nothing at all | before it connected | scanning; wrong name, or out of range. See the name section above |
| `an LE device connected …` | between connecting and enabling notifications | **building its GATT profile**: `mstBuildProfile` and the CCCD write |
| `a key subscribed …` | between enabling notifications and its first word | **the rest of its own connection setup**. The car had sent it nothing, so nothing the car did caused it |
| `sending the handshake reply (session info …)` | turning session info into a session key | **the session key derivation**, the step that historically reset this watch |
| `sending an encrypted command response …` | decrypting or verifying a reply | AES-GCM on the notification callback |
| `fragment 3/9 …` | part way through a burst | reassembly, or the write path re-entering the stack |

Rows two and three are only distinguishable because the car watches Bluetooth
connections separately from subscriptions. It has to: a `GattServiceProvider`
is told nothing when a central connects, so the first thing this program would
otherwise hear is the CCCD write, and a watch that dies while building its
profile would look exactly like one that never found the car. Those are a crash
and a name problem respectively, and they are fixed in different files.

Windows will not say *which* device is talking to this service, so that watcher
sees every LE connection the machine has. Everything already connected when the
car starts is listed once, as furniture:

```
0.308 + 0.002  link  already connected, and therefore not the key:
                     Keychron K10 Max (…), MX Master 3S (…)
```

The second row is the one worth being precise about, because it is the one that
looks like a car problem and is not. It is reported in its own words:

```
02:14:42  6.041 + 3.427  silent  nothing from the key for 3.4s (×1). It subscribed
                                 and then went quiet without being sent anything,
                                 whatever stopped it, it was doing it to itself
02:14:46  9.635 + 1.596  link    the key disconnected after 7.022s of silence, without
                                 ever being sent anything, it did not get as far as
                                 saying hello
```

A healthy exchange, for comparison. Note that every gap is milliseconds:

```
0.970 + 0.018  rx      a complete message of 112 bytes
0.971 + 0.001  rx      it is a handshake request for domain 2
0.976 + 0.006  session handshake from an enrolled key 04ef071612e1db22… on domain 2
0.977 + 0.000  tx      sending the handshake reply (session info: the key now has to
                       derive a session key from it), 175 bytes
0.995 + 0.018  rx      a complete message of 181 bytes      ← the watch answered in 18ms
```

That last delta is the measurement. On a watch it is the interval that decides
whether the device survives the connection.

## While it is running

Single keystrokes, which is also what a script writes to its stdin one line at a
time. That is how `tools/verify-mock-car.js` drives the parts of a car that
need a person standing next to it:

| Key | What the car does |
|---|---|
| `k` | the owner taps their keycard, approving a pending enrolment |
| `d` | leave the driver's door open, or shut it. A car with a door open refuses to lock |
| `c` | shut every closure |
| `r` | reboot: rotate the epoch and void every session, as a real module does at power-up |
| `x` | forget every enrolled key |
| `n` | reject the next command as a repeated counter |
| `b` | broadcast an unsolicited status frame |
| `s` | print the car's state |
| `w` | list enrolled keys |
| `q` | quit |

## What the car actually models

**It enforces what a car enforces.** A key must be on the whitelist; the epoch
must match; counters must strictly increase; a command must not have expired
against the car's own clock. Each failure comes back as the fault a real vehicle
sends, with authenticated session info attached so a client can resync and
replay, which is the path `r` and `n` exist to exercise.

**Enrolment needs the tap.** An add-key request is unauthenticated by design, and
answering it with `OperationStatus.WAIT` is all the car does until somebody
presses `k`. `--auto-tap` skips the wait for unattended runs; it is off by
default because that tap is the entire security model.

**Closures move, and take time doing it.** Opening the boot reports `opening`,
then `open` a couple of seconds later (`--motion-ms`). A door or the frunk pops
its latch and is `open` at once. `--no-liftgate` models a car with no powered
boot, which ignores a close silently, exactly as the real one does. No Tesla
closes a frunk remotely, and this one will not either.

**It refuses things.** Locking with something standing open comes back as
`CLOSURES_OPEN` in a `NominalError`, not as a protocol fault, because that is
the car declining for a physical reason rather than a cryptographic one.

**It answers success with silence.** An empty `FromVCSECMessage` is the
acknowledgement, so a client that treats "sent" as "done" has nothing to go on
but a status read, which is the point of modelling motion at all.

**Its identity survives restarts.** The vehicle keypair, epoch, whitelist and
counters are kept in `%LOCALAPPDATA%\teslamock\<VIN>.json`. This matters more
than it looks: a key caches the session key it derived from the vehicle's public
key, because that derivation is the one expensive step in the protocol, 87
seconds on a Zepp watch, which is why the watch has a phone do it. A mock that
generated a new keypair every launch would force that round trip every time you
tested. `--fresh` starts a new car deliberately; `--no-state` keeps nothing.

## Verifying it

```
node tools/verify-mock-car.js
```

Runs the watch's own client (`lib/tesla/client.js`) against this program over a
socket: enrolment refused before the tap, handshake, every command, a status
read, a lock refused for an open door, recovery from a counter fault and from a
reboot, and rejection once the key is forgotten.

The value is in what the two sides do *not* share. The client's cryptography is
hand-written JavaScript with no BigInt; this car's is .NET's. The client encodes
the signature metadata with its own TLV writer; this car encodes it with
another. They agree byte for byte or the run fails. A bug that cancelled itself
out in `tools/mock-vehicle.js`, where both halves are the same JavaScript in one
process, cannot cancel itself out here.

## Checking the Bluetooth side by hand

Windows cannot scan its own advertisements, so a second radio is needed to see
what this looks like from outside. With nRF Connect on a phone: scan, and the
peripheral should appear under whatever name `teslamock doctor` reported, with
service `00000211-b2d1-43f0-9b88-960cebf8b91e` carrying `…0212` (write) and
`…0213` (notify). Subscribe to `…0213` and the mock logs the subscription.

### "the stack would not advertise the vehicle service (Aborted)"

Windows keeps a GATT service registered for a while after the process that
registered it has gone, and while it does, a second registration of the same
UUID goes to `Aborted` instead of `Started`. So the usual cause is the *previous*
run: killed, crashed, or one that failed on its way up and did not hand the
service back. The mock releases the registration on every exit path, including
failed starts, and retries once with a pause when it sees this. If it still will
not start, wait a few seconds and try again, or switch Bluetooth off and on;
nothing about the hardware has gone wrong.

`npm test` picks up `test/mock-car.test.js` as well, which runs the same
conversation as assertions and **skips itself when mock-car has not been built**,
the test suite must not need a .NET SDK to pass.

## Other clients

Nothing here is specific to the watch. The car answers Tesla's protocol as
published in the [`vehicle-command`](https://github.com/teslamotors/vehicle-command)
SDK, so any client that speaks it over BLE should be able to talk to this one,
including Tesla's own Go tooling on a machine where the advertised name can be
set. That has not been tried here, and the name is the part that would need
solving first; what has been tried is this repository's client, which is what
the tests cover.

## What this is not

It is not a Tesla. It implements the VCSEC domain (lock, unlock, closures, wake,
status, enrolment) and not infotainment, so climate and charging are absent. It
does not implement the vehicle's own security beyond the protocol: it will hand
out a session to any key on its whitelist and its whitelist is a JSON file. That
is the correct shape for a test fixture and the wrong shape for anything else.

Not affiliated with, endorsed by, or sponsored by Tesla, Inc.
