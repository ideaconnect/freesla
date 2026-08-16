// Framing has to survive whatever chunk boundaries the BLE stack happens to
// pick, so these tests deliver the same bytes under several fragmentations.

import { test } from 'node:test'
import assert from 'node:assert'

import { frameMessage, createReassembler, MAX_MESSAGE_SIZE } from '../lib/tesla/framing.js'

function hex (u8) {
  return Buffer.from(u8).toString('hex')
}

function concat (chunks) {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out
}

test('prefixes the message with a big-endian length', () => {
  const message = new Uint8Array([0xaa, 0xbb, 0xcc])
  assert.strictEqual(hex(concat(frameMessage(message, 0))), '0003aabbcc')

  const big = new Uint8Array(300).fill(0x11)
  assert.strictEqual(hex(concat(frameMessage(big, 0))).slice(0, 4), '012c')
})

test('splits into chunks no larger than the mtu payload', () => {
  const message = new Uint8Array(100).fill(7)
  const chunks = frameMessage(message, 20)

  assert.strictEqual(chunks.length, Math.ceil(102 / 20))
  for (const c of chunks) assert.ok(c.length <= 20, 'chunk exceeded mtu')
  assert.strictEqual(concat(chunks).length, 102)
})

test('refuses to frame an over-long message', () => {
  assert.throws(
    () => frameMessage(new Uint8Array(MAX_MESSAGE_SIZE + 1), 20),
    /exceeds the protocol limit/
  )
})

test('reassembles a message delivered in mtu-sized chunks', () => {
  const message = new Uint8Array(250)
  for (let i = 0; i < message.length; i++) message[i] = i & 0xff

  const rx = createReassembler()
  const received = []
  for (const chunk of frameMessage(message, 20)) {
    for (const m of rx.push(chunk)) received.push(m)
  }

  assert.strictEqual(received.length, 1)
  assert.strictEqual(hex(received[0]), hex(message))
})

test('reassembles when the length prefix itself is split', () => {
  const message = new Uint8Array([1, 2, 3, 4, 5])
  const framed = concat(frameMessage(message, 0))

  const rx = createReassembler()
  assert.deepStrictEqual(rx.push(framed.subarray(0, 1)), [], 'emitted on a partial header')
  const out = rx.push(framed.subarray(1))
  assert.strictEqual(out.length, 1)
  assert.strictEqual(hex(out[0]), hex(message))
})

test('separates two messages arriving in one chunk', () => {
  const a = new Uint8Array([0x0a, 0x0b])
  const b = new Uint8Array([0x0c, 0x0d, 0x0e])
  const merged = concat([concat(frameMessage(a, 0)), concat(frameMessage(b, 0))])

  const out = createReassembler().push(merged)
  assert.strictEqual(out.length, 2)
  assert.strictEqual(hex(out[0]), hex(a))
  assert.strictEqual(hex(out[1]), hex(b))
})

test('survives byte-at-a-time delivery', () => {
  const message = new Uint8Array(60).fill(0x5a)
  const framed = concat(frameMessage(message, 0))

  const rx = createReassembler()
  const received = []
  for (let i = 0; i < framed.length; i++) {
    for (const m of rx.push(framed.subarray(i, i + 1))) received.push(m)
  }

  assert.strictEqual(received.length, 1)
  assert.strictEqual(hex(received[0]), hex(message))
})

test('handles an empty message body', () => {
  const rx = createReassembler()
  const out = rx.push(new Uint8Array([0x00, 0x00]))
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].length, 0)
})

test('rejects a desynchronised stream instead of stalling', () => {
  const rx = createReassembler()
  assert.throws(() => rx.push(new Uint8Array([0xff, 0xff, 0x00])), /out of range/)
  assert.strictEqual(rx.pending, 0, 'buffer not cleared after error')
})
