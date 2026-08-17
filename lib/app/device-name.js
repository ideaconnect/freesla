// Which name the watch goes looking for.
//
// Normally the one a Tesla derives from its VIN, which is the whole of how a
// particular car is picked out of everything else advertising nearby. The
// exception is a build made for testing against mock-car, where the name in the
// air belongs to the Windows machine running it and cannot be changed from
// inside the program. freesla.config.js carries that name; see the comment
// there for why the override lives at build time rather than in settings.

import { vehicleLocalName } from '../tesla/messages.js'
import { BLE_NAME_OVERRIDE } from '../../freesla.config.js'

// The configured override, or null when there is none.
//
// Takes the value as an argument so it can be exercised without a build, and
// falls back to the configured one when nothing is passed -- undefined means
// "whatever this build was made with", which is what every caller on the watch
// wants.
//
// Trimmed because it is pasted in by hand: a trailing space or newline would
// otherwise produce a name that matches nothing, and a scan that finds nothing
// looks exactly like a car that is not there.
export function localNameOverride (override) {
  const value = override === undefined ? BLE_NAME_OVERRIDE : override
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

// The name to scan for: the override if this build carries one, otherwise the
// name this VIN derives.
export function expectedLocalName (vin, override) {
  return localNameOverride(override) || vehicleLocalName(vin)
}
