// Build-time configuration.
//
// Zeus inlines this into the bundle, so nothing here is read on the watch and
// nothing here can be changed after a build. It exists for one setting, and
// that setting exists for one reason: a Tesla is found by name, and on Windows
// a program cannot choose the name its own advertisements carry.

// The BLE name the watch scans for, instead of the one derived from the VIN.
//
// Empty in every committed build, and it has to stay empty for a real car: a
// Tesla advertises S<16 hex>C derived from its VIN, and that derivation is what
// picks one specific car out of a car park. A build with anything here will not
// find a real Tesla at all -- it looks for this name and nothing else.
//
// Set it only to test against mock-car. Windows takes the name in an
// advertisement from the Bluetooth radio rather than from the program, so the
// mock advertises under the machine's own name whatever it would prefer to be
// called. Rather than fight that -- the registry key holding the radio's name
// belongs to SYSTEM -- point the watch at the machine instead:
//
//   export const BLE_NAME_OVERRIDE = 'DESKTOP-4F2A'
//
// `teslamock` prints the exact line to paste, with the name this machine really
// advertises already filled in. It is compared exactly as the scan reports it,
// so the case has to match.
export const BLE_NAME_OVERRIDE = ''

// Record each step of a connection attempt to storage, so that if the watch
// restarts mid-connection the next launch can say where it stopped.
//
// This is the only instrument that survives a watchdog reset. The screen goes
// with the reboot, the log goes with it, and the car at the other end can only
// account for what reached the air -- storage is what is left.
//
// Off by default, and not merely out of tidiness. Each step costs a synchronous
// write to flash, and several of them land inside the Bluetooth stack's own
// callbacks, which is one of the things a stall in this window is suspected of
// being. Turning it on to investigate that changes what is being measured. If
// the reset gets *worse* with this on, that is itself the finding.
export const CONNECT_BREADCRUMB = false
