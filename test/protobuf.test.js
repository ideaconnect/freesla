// Wire-format checks against the encodings published in the protobuf spec,
// plus round trips through our own decoder.

import { test } from 'node:test'
import assert from 'node:assert'

import {
  createWriter, writeVarintField, writeBytesField, writeStringField,
  writeMessageField, writeEmptyMessageField, finishWriter,
  decode, first, firstMessage, utf8Encode, utf8Decode
} from '../lib/tesla/protobuf.js'

function hex (u8) {
  return Buffer.from(u8).toString('hex')
}

test('encodes the varint example from the protobuf spec', () => {
  const w = createWriter()
  writeVarintField(w, 1, 150)
  assert.strictEqual(hex(finishWriter(w)), '089601')
})

test('encodes the string example from the protobuf spec', () => {
  const w = createWriter()
  writeStringField(w, 2, 'testing')
  assert.strictEqual(hex(finishWriter(w)), '120774657374696e67')
})

test('encodes large field numbers and multi-byte varints', () => {
  const w = createWriter()
  writeVarintField(w, 16, 1)
  assert.strictEqual(hex(finishWriter(w)), '8001 01'.replace(/ /g, ''))

  const w2 = createWriter()
  writeVarintField(w2, 1, 300)
  assert.strictEqual(hex(finishWriter(w2)), '08ac02')
})

test('round trips varints across magnitudes', () => {
  const values = [0, 1, 127, 128, 255, 256, 16383, 16384, 65535,
    2147483647, 4294967295, 4294967296, 1099511627775, 9007199254740991]
  for (const v of values) {
    const w = createWriter()
    writeVarintField(w, 3, v)
    const fields = decode(finishWriter(w))
    assert.strictEqual(first(fields, 3), v, `value ${v}`)
  }
})

test('round trips bytes and nested messages', () => {
  const payload = new Uint8Array([1, 2, 3, 250, 255, 0])

  const inner = createWriter()
  writeVarintField(inner, 1, 42)
  writeBytesField(inner, 2, payload)

  const outer = createWriter()
  writeMessageField(outer, 5, inner)
  writeVarintField(outer, 6, 7)

  const fields = decode(finishWriter(outer))
  assert.strictEqual(first(fields, 6), 7)

  const nested = firstMessage(fields, 5)
  assert.strictEqual(first(nested, 1), 42)
  assert.strictEqual(hex(first(nested, 2)), hex(payload))
})

test('preserves an empty submessage as a present field', () => {
  const w = createWriter()
  writeEmptyMessageField(w, 4)
  const encoded = finishWriter(w)
  assert.strictEqual(hex(encoded), '2200')

  const fields = decode(encoded)
  assert.ok(fields[4], 'empty submessage lost')
  assert.strictEqual(first(fields, 4).length, 0)
})

test('collects repeated fields in order', () => {
  const w = createWriter()
  writeVarintField(w, 1, 10)
  writeVarintField(w, 1, 20)
  writeVarintField(w, 1, 30)

  const fields = decode(finishWriter(w))
  assert.deepStrictEqual(fields[1], [10, 20, 30])
})

test('skips absent optional fields entirely', () => {
  const w = createWriter()
  writeVarintField(w, 1, undefined)
  writeBytesField(w, 2, null)
  writeVarintField(w, 3, 5)
  assert.strictEqual(hex(finishWriter(w)), '1805')
})

test('utf8 round trips including multi-byte and astral characters', () => {
  for (const text of ['', 'abc', 'VIN12345', 'żółw', '日本語', 'emoji \u{1F511} key']) {
    assert.strictEqual(utf8Decode(utf8Encode(text)), text, JSON.stringify(text))
  }
  assert.strictEqual(hex(utf8Encode('é')), 'c3a9')
})

test('rejects malformed input rather than returning junk', () => {
  assert.throws(() => decode(new Uint8Array([0x12, 0x40, 0x01])), /truncated/)
  assert.throws(() => decode(new Uint8Array([0x0f])), /wire type/)
  assert.throws(() => decode(new Uint8Array([0x08])), /truncated varint/)
})
