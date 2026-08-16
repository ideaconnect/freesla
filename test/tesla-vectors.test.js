// Conformance against the test vectors published in Tesla's protocol spec.
//
// These are the tests that matter most: the symmetric primitives can be checked
// against Node, but nothing local can tell us we assembled the protocol the way
// a vehicle expects. Reproducing Tesla's own byte strings is the closest thing
// to a real car available offline.

import { test } from 'node:test'
import assert from 'node:assert'

import { sha1 } from '../lib/crypto/sha1.js'
import { sha256 } from '../lib/crypto/sha256.js'
import { gcmEncrypt } from '../lib/crypto/gcm.js'
import {
  vehicleLocalName, rkeAction, openTrunk, closeTrunk, stopClosure, openFrunk,
  openDoor, openAllDoors, closureMove, openChargePort, closeChargePort,
  vehicleStatusRequest,
  buildSignedCommand, parseRoutableMessage, buildSessionInfo, parseSessionInfo
} from '../lib/tesla/messages.js'
import { commandMetadata, responseMetadata, requestHash } from '../lib/tesla/session.js'
import { finish, checksum } from '../lib/tesla/metadata.js'
import { decode, first } from '../lib/tesla/protobuf.js'
import {
  RKE_ACTION, DOMAIN, SIGNATURE_TYPE, CLOSURE_FIELD, CLOSURE_MOVE
} from '../lib/tesla/constants.js'

function hex (u8) {
  return Buffer.from(u8).toString('hex')
}

function bin (hexString) {
  return new Uint8Array(Buffer.from(hexString.replace(/\s/g, ''), 'hex'))
}

const VIN = '5YJ30123456789ABC'
const SESSION_KEY = bin('1b2fce19967b79db696f909cff89ea9a')
const EPOCH = bin('4c463f9cc0d3d26906e982ed224adde6')

test('vehicle local name derives from the vin', () => {
  assert.strictEqual(
    hex(sha1(new Uint8Array(Buffer.from('5YJS0000000000000', 'ascii')))),
    '1a87a5a75f3df8584b5b3e531a2edeb4b40b53d3'
  )
  assert.strictEqual(vehicleLocalName('5YJS0000000000000'), 'S1a87a5a75f3df858C')
  assert.strictEqual(vehicleLocalName('5YJS0000000000000').length, 18)
})

test('session key is sha1 of the shared x-coordinate truncated to 16 bytes', () => {
  const sharedX = bin('6b9a2844b300e6a85e4474f70b31b23de2d8f7d3e594784cdfe8318031442f8b')
  assert.strictEqual(hex(sha1(sharedX).subarray(0, 16)), '1b2fce19967b79db696f909cff89ea9a')
})

test('command metadata matches the published infotainment vector', () => {
  const meta = commandMetadata({
    domain: DOMAIN.INFOTAINMENT,
    vin: VIN,
    epoch: EPOCH,
    expiresAt: 2655,
    counter: 7,
    flags: 2
  })

  assert.strictEqual(
    hex(finish(meta)),
    '000105' +
    '010103' +
    '021135594a3330313233343536373839414243' +
    '03104c463f9cc0d3d26906e982ed224adde6' +
    '040400000a5f' +
    '050400000007' +
    '070400000002' +
    'ff'
  )
})

test('metadata omits the flags field entirely when flags are zero', () => {
  const meta = commandMetadata({
    domain: DOMAIN.VEHICLE_SECURITY,
    vin: VIN,
    epoch: EPOCH,
    expiresAt: 2655,
    counter: 7,
    flags: 0
  })
  const encoded = hex(finish(meta))
  assert.ok(!encoded.includes('0704'), 'zero flags were emitted')
  assert.ok(encoded.endsWith('050400000007ff'), 'terminator misplaced')
})

test('aes-gcm command encryption matches the published vector', () => {
  const meta = commandMetadata({
    domain: DOMAIN.INFOTAINMENT,
    vin: VIN,
    epoch: EPOCH,
    expiresAt: 2655,
    counter: 7,
    flags: 2
  })

  // The additional authenticated data is the digest of the metadata, not the
  // metadata itself.
  const aad = checksum(meta)
  assert.strictEqual(hex(aad), hex(sha256(finish(meta))))

  const result = gcmEncrypt(SESSION_KEY, bin('dbf79447fa156674dae1caed'), bin('120452020801'), aad, 16)
  assert.strictEqual(hex(result.ciphertext), '38038e8c0f2e')
  assert.strictEqual(hex(result.tag), 'c228e0ff64991481db3a7bbc133696c5')
})

test('rke actions encode with their zero value present', () => {
  // UNLOCK is enum value 0 inside a oneof, so it must still appear on the wire.
  assert.strictEqual(hex(rkeAction(RKE_ACTION.UNLOCK)), '1000')
  assert.strictEqual(hex(rkeAction(RKE_ACTION.LOCK)), '1001')
  assert.strictEqual(hex(rkeAction(RKE_ACTION.WAKE_VEHICLE)), '101e')
})

test('trunk and frunk encode as closure moves', () => {
  assert.strictEqual(hex(openTrunk()), '22022803')
  assert.strictEqual(hex(openFrunk()), '22023003')
})

test('closing a closure differs from opening it only in the move type', () => {
  // OPEN is 3 and CLOSE is 4, so the two encodings must differ in exactly the
  // final byte. Getting this backwards would shut a boot instead of opening it.
  assert.strictEqual(hex(closeTrunk()), '22022804')
  assert.strictEqual(hex(openTrunk()).slice(0, -1), hex(closeTrunk()).slice(0, -1))
})

test('doors are actuated as separate single-field messages', () => {
  // Tesla's SDK builds a ClosureMoveRequest from a switch that emits exactly one
  // field, so a multi-field request has never been on the wire from their
  // tooling and no firmware is known to handle one. Four ordinary messages stay
  // on the path the vehicle demonstrably accepts.
  //   field 1 -> tag 0x08, field 2 -> 0x10, field 3 -> 0x18, field 4 -> 0x20
  assert.strictEqual(hex(openDoor(CLOSURE_FIELD.FRONT_DRIVER_DOOR)), '22020803')
  assert.strictEqual(hex(openDoor(CLOSURE_FIELD.FRONT_PASSENGER_DOOR)), '22021003')
  assert.strictEqual(hex(openDoor(CLOSURE_FIELD.REAR_DRIVER_DOOR)), '22021803')
  assert.strictEqual(hex(openDoor(CLOSURE_FIELD.REAR_PASSENGER_DOOR)), '22022003')

  const sequence = openAllDoors()
  assert.strictEqual(sequence.length, 4, 'expected one message per door')
  assert.deepStrictEqual(sequence.map(hex),
    ['22020803', '22021003', '22021803', '22022003'])
  for (const message of sequence) {
    assert.strictEqual(message.length, 4, 'a door message should carry one field')
  }
})

test('there is no way to command a door or frunk closed', async () => {
  // Deliberate omissions, not oversights: only a Model X can pull a door shut
  // and no Tesla can shut a frunk, so a button for either would be inert on
  // almost every car and unsafe on the rest.
  const messages = await import('../lib/tesla/messages.js')
  assert.strictEqual(messages.closeDoors, undefined, 'closeDoors was reintroduced')
  assert.strictEqual(messages.closeFrunk, undefined, 'closeFrunk was reintroduced')
})

test('stop halts a closure mid-travel', () => {
  // STOP is 2. Worth having: if the car ignores it nothing happens, and if it
  // obeys it stops a powered panel closing on something.
  assert.strictEqual(hex(stopClosure(CLOSURE_FIELD.REAR_TRUNK)), '22022802')
})

test('a vehicle status request is an empty information request', () => {
  // GET_STATUS is enum 0 and informationRequestType is not in a oneof, so proto3
  // omits it and the submessage is empty.
  assert.strictEqual(hex(vehicleStatusRequest()), '0a00')
})

test('closure fields are emitted in ascending order whatever order they are given', () => {
  const scrambled = closureMove(
    [CLOSURE_FIELD.REAR_PASSENGER_DOOR, CLOSURE_FIELD.FRONT_DRIVER_DOOR], CLOSURE_MOVE.OPEN)
  const ordered = closureMove(
    [CLOSURE_FIELD.FRONT_DRIVER_DOOR, CLOSURE_FIELD.REAR_PASSENGER_DOOR], CLOSURE_MOVE.OPEN)

  assert.strictEqual(hex(scrambled), hex(ordered))
  assert.strictEqual(hex(scrambled), '2204' + '0803' + '2003')
})

test('the charge port is reachable as a closure too', () => {
  assert.strictEqual(hex(openChargePort()), '22023803')
  assert.strictEqual(hex(closeChargePort()), '22023804')
})

test('a closure message round trips through the parser', () => {
  for (const door of [1, 2, 3, 4]) {
    const fields = decode(openDoor(door))
    const request = decode(first(fields, 4))

    assert.strictEqual(first(request, door), CLOSURE_MOVE.OPEN, 'door ' + door + ' missing')
    // One field per message, so no other door should appear.
    assert.strictEqual(Object.keys(request).length, 1, 'door ' + door + ' carried extra fields')
  }
})

test('a full signed unlock reproduces the published message byte for byte', () => {
  const meta = commandMetadata({
    domain: DOMAIN.VEHICLE_SECURITY,
    vin: VIN,
    epoch: EPOCH,
    expiresAt: 2655,
    counter: 7,
    flags: 2
  })

  const encrypted = gcmEncrypt(
    SESSION_KEY,
    bin('000102030405060708090a0b'),
    rkeAction(RKE_ACTION.UNLOCK),
    checksum(meta),
    16
  )
  assert.strictEqual(hex(encrypted.ciphertext), '095c', 'ciphertext')
  assert.strictEqual(hex(encrypted.tag), 'fb2c706e06e0a7ddf7f339d1faa0fb74', 'gcm tag')

  const message = buildSignedCommand({
    domain: DOMAIN.VEHICLE_SECURITY,
    routingAddress: bin('0a7962c10d38b61dd2a7722780a4f096'),
    ciphertext: encrypted.ciphertext,
    publicKey: bin(
      '04b2b6bc68c2da0665ce656815594996c62394edd8bea905fe781a754fe6a845a71' +
      '4330902f225e9269d466e05b349981fda9d85cc23c6fb444aa73b629105dc6e'
    ),
    epoch: EPOCH,
    nonce: bin('000102030405060708090a0b'),
    counter: 7,
    expiresAt: 2655,
    tag: encrypted.tag,
    uuid: bin('05514f57616bcc81a8ce0f9d7b483229'),
    flags: 2
  })

  assert.strictEqual(message.length, 181, 'message length')
  assert.strictEqual(
    hex(message),
    '320208023a1212100a7962c10d38b61dd2a7722780a4f0965202095c6a80010a430a4104' +
    'b2b6bc68c2da0665ce656815594996c62394edd8bea905fe781a754fe6a845a714330902' +
    'f225e9269d466e05b349981fda9d85cc23c6fb444aa73b629105dc6e2a390a104c463f9c' +
    'c0d3d26906e982ed224adde6120c000102030405060708090a0b1807255f0a00002a10fb' +
    '2c706e06e0a7ddf7f339d1faa0fb749a031005514f57616bcc81a8ce0f9d7b483229a003' +
    '02'
  )
})

test('a signed command parses back to the values that built it', () => {
  const raw = bin(
    '320208023a1212100a7962c10d38b61dd2a7722780a4f0965202095c6a80010a430a4104' +
    'b2b6bc68c2da0665ce656815594996c62394edd8bea905fe781a754fe6a845a714330902' +
    'f225e9269d466e05b349981fda9d85cc23c6fb444aa73b629105dc6e2a390a104c463f9c' +
    'c0d3d26906e982ed224adde6120c000102030405060708090a0b1807255f0a00002a10fb' +
    '2c706e06e0a7ddf7f339d1faa0fb749a031005514f57616bcc81a8ce0f9d7b483229a003' +
    '02'
  )

  const parsed = parseRoutableMessage(raw)
  assert.strictEqual(parsed.toDestination.domain, DOMAIN.VEHICLE_SECURITY)
  assert.strictEqual(hex(parsed.fromDestination.routingAddress), '0a7962c10d38b61dd2a7722780a4f096')
  assert.strictEqual(hex(parsed.payload), '095c')
  assert.strictEqual(hex(parsed.uuid), '05514f57616bcc81a8ce0f9d7b483229')
  assert.strictEqual(parsed.flags, 2)
})

test('response metadata matches the published vector', () => {
  const meta = responseMetadata({
    domain: DOMAIN.VEHICLE_SECURITY,
    vin: VIN,
    counter: 1,
    flags: 0,
    requestHash: requestHash(SIGNATURE_TYPE.AES_GCM_PERSONALIZED, bin('fb2c706e06e0a7ddf7f339d1faa0fb74')),
    fault: 0
  })

  assert.strictEqual(
    hex(finish(meta)),
    '000109' +
    '010102' +
    '021135594a3330313233343536373839414243' +
    '050400000001' +
    '070400000000' +
    '081105fb2c706e06e0a7ddf7f339d1faa0fb74' +
    '090400000000' +
    'ff'
  )
})

test('request hash is the signature type followed by 16 tag bytes', () => {
  const hash = requestHash(SIGNATURE_TYPE.AES_GCM_PERSONALIZED, bin('fb2c706e06e0a7ddf7f339d1faa0fb74'))
  assert.strictEqual(hash.length, 17)
  assert.strictEqual(hex(hash), '05fb2c706e06e0a7ddf7f339d1faa0fb74')

  // VCSEC HMAC tags are 32 bytes and must be truncated to the same 17-byte shape.
  const truncated = requestHash(SIGNATURE_TYPE.HMAC_PERSONALIZED, bin('00'.repeat(32)))
  assert.strictEqual(truncated.length, 17)
})

test('session info round trips through build and parse', () => {
  const encoded = buildSessionInfo({
    counter: 6,
    publicKey: bin('04' + 'aa'.repeat(64)),
    epoch: EPOCH,
    clockTime: 2650,
    status: 0
  })

  const parsed = parseSessionInfo(encoded)
  assert.strictEqual(parsed.counter, 6)
  assert.strictEqual(hex(parsed.epoch), hex(EPOCH))
  assert.strictEqual(parsed.clockTime, 2650, 'clock_time is fixed32 little-endian')
  assert.strictEqual(parsed.publicKey.length, 65)
})
