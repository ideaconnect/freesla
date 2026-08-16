// Minimal protobuf wire-format codec.
//
// Tesla's schemas are far larger than what a key fob touches, so rather than
// generating code from the .proto files this handles the four wire types
// directly and lets the message modules name their own fields. Values are kept
// as plain numbers and Uint8Arrays; nothing here allocates a class per field.

const WIRE_VARINT = 0
const WIRE_64BIT = 1
const WIRE_LENGTH = 2
const WIRE_32BIT = 5

export function createWriter () {
  return { bytes: [] }
}

function pushVarint (out, value) {
  while (value >= 0x80) {
    out.push((value & 0x7f) | 0x80)
    value = Math.floor(value / 128)
  }
  out.push(value & 0x7f)
}

function pushTag (writer, field, wireType) {
  pushVarint(writer.bytes, field * 8 + wireType)
}

export function writeVarintField (writer, field, value) {
  if (value === undefined || value === null) return writer
  pushTag(writer, field, WIRE_VARINT)
  pushVarint(writer.bytes, value)
  return writer
}

export function writeBoolField (writer, field, value) {
  if (!value) return writer
  return writeVarintField(writer, field, 1)
}

// Wire type 5. Note that protobuf serialises fixed32 little-endian, while the
// same values appear big-endian inside the signature metadata; mixing the two
// up produces a valid-looking message the vehicle silently rejects.
export function writeFixed32Field (writer, field, value) {
  if (value === undefined || value === null) return writer
  pushTag(writer, field, WIRE_32BIT)
  writer.bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
  return writer
}

export function writeBytesField (writer, field, value) {
  if (!value) return writer
  pushTag(writer, field, WIRE_LENGTH)
  pushVarint(writer.bytes, value.length)
  for (let i = 0; i < value.length; i++) writer.bytes.push(value[i])
  return writer
}

export function writeStringField (writer, field, text) {
  if (text === undefined || text === null) return writer
  return writeBytesField(writer, field, utf8Encode(text))
}

// Embeds an already-finished submessage as a length-delimited field.
export function writeMessageField (writer, field, subWriter) {
  if (!subWriter) return writer
  const inner = subWriter.bytes
  pushTag(writer, field, WIRE_LENGTH)
  pushVarint(writer.bytes, inner.length)
  for (let i = 0; i < inner.length; i++) writer.bytes.push(inner[i])
  return writer
}

// Writes a submessage even when it carries no fields. Presence is meaningful in
// protobuf, and several Tesla messages are empty markers whose mere existence
// selects a variant of a oneof.
export function writeEmptyMessageField (writer, field) {
  pushTag(writer, field, WIRE_LENGTH)
  pushVarint(writer.bytes, 0)
  return writer
}

export function finishWriter (writer) {
  return Uint8Array.from(writer.bytes)
}

export function utf8Encode (text) {
  const out = []
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i)
    if (c < 0x80) {
      out.push(c)
    } else if (c < 0x800) {
      out.push(0xc0 | (c >>> 6), 0x80 | (c & 0x3f))
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00)
      i++
      out.push(0xf0 | (c >>> 18), 0x80 | ((c >>> 12) & 0x3f),
        0x80 | ((c >>> 6) & 0x3f), 0x80 | (c & 0x3f))
    } else {
      out.push(0xe0 | (c >>> 12), 0x80 | ((c >>> 6) & 0x3f), 0x80 | (c & 0x3f))
    }
  }
  return Uint8Array.from(out)
}

export function utf8Decode (bytes) {
  let text = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (b < 0x80) {
      text += String.fromCharCode(b)
    } else if (b < 0xe0) {
      text += String.fromCharCode(((b & 0x1f) << 6) | (bytes[++i] & 0x3f))
    } else if (b < 0xf0) {
      text += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f))
    } else {
      const cp = ((b & 0x07) << 18) | ((bytes[++i] & 0x3f) << 12) |
        ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f)
      const off = cp - 0x10000
      text += String.fromCharCode(0xd800 + (off >> 10), 0xdc00 + (off & 0x3ff))
    }
  }
  return text
}

// Decodes into { fieldNumber: [values] }. Repeated fields fall out naturally,
// and unknown fields are preserved rather than dropped so that a message can be
// inspected without a full schema.
export function decode (bytes) {
  const fields = {}
  let pos = 0

  function readVarint () {
    let result = 0
    let shift = 1
    while (pos < bytes.length) {
      const b = bytes[pos++]
      result += (b & 0x7f) * shift
      if ((b & 0x80) === 0) return result
      shift *= 128
      if (shift > 72057594037927936) throw new Error('protobuf: varint too long')
    }
    throw new Error('protobuf: truncated varint')
  }

  function put (field, value) {
    if (fields[field]) fields[field].push(value)
    else fields[field] = [value]
  }

  while (pos < bytes.length) {
    const tag = readVarint()
    const field = Math.floor(tag / 8)
    const wireType = tag & 7
    if (field === 0) throw new Error('protobuf: zero field number')

    if (wireType === WIRE_VARINT) {
      put(field, readVarint())
    } else if (wireType === WIRE_LENGTH) {
      const len = readVarint()
      if (pos + len > bytes.length) throw new Error('protobuf: truncated field')
      put(field, bytes.subarray(pos, pos + len))
      pos += len
    } else if (wireType === WIRE_32BIT) {
      if (pos + 4 > bytes.length) throw new Error('protobuf: truncated fixed32')
      put(field, bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] * 16777216))
      pos += 4
    } else if (wireType === WIRE_64BIT) {
      if (pos + 8 > bytes.length) throw new Error('protobuf: truncated fixed64')
      put(field, bytes.subarray(pos, pos + 8))
      pos += 8
    } else {
      throw new Error('protobuf: unsupported wire type ' + wireType)
    }
  }

  return fields
}

export function first (fields, field) {
  const values = fields[field]
  return values ? values[0] : undefined
}

export function firstMessage (fields, field) {
  const raw = first(fields, field)
  return raw === undefined ? undefined : decode(raw)
}
