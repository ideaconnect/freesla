// Hex conversion. Watch storage holds strings, so every binary value that
// needs to survive a restart passes through here.

const DIGITS = '0123456789abcdef'

export function toHex (bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += DIGITS[(bytes[i] >>> 4) & 0x0f] + DIGITS[bytes[i] & 0x0f]
  }
  return out
}

export function fromHex (text) {
  if (!text || text.length % 2 !== 0) return null

  const out = new Uint8Array(text.length >>> 1)
  for (let i = 0; i < out.length; i++) {
    const hi = DIGITS.indexOf(text.charAt(i * 2).toLowerCase())
    const lo = DIGITS.indexOf(text.charAt(i * 2 + 1).toLowerCase())
    if (hi < 0 || lo < 0) return null
    out[i] = (hi << 4) | lo
  }
  return out
}
