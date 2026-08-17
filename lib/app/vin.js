// The VIN rules, in one place.
//
// These used to exist three times over -- the watch, the phone settings screen
// and the companion service each carried their own copy. That is how a VIN
// could read as accepted on the phone and still never reach the watch: only one
// of the three actually decided whether it was worth forwarding.

// Loose: what the owner has typed so far, tidied up. Used while a VIN is still
// being entered, where rejecting an incomplete one outright would mean the
// field could never be filled in.
export function cleanVin (input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

// Strict: a complete, plausible VIN, or null. Everything that acts on a VIN --
// storing it, forwarding it, deriving the car's BLE name from it -- goes
// through this.
export function normaliseVin (input) {
  const vin = cleanVin(input)
  if (vin.length !== 17) return null
  // A VIN never contains I, O or Q; those characters are always a misread 1
  // or 0, so a string carrying them is not a VIN that was read correctly.
  if (/[IOQ]/.test(vin)) return null
  return vin
}
