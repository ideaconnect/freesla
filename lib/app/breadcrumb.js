// Where the watch got to, kept somewhere a reboot cannot reach.
//
// A Zepp watch that trips its watchdog does not fail, it restarts: the screen
// is gone, the console is gone, and the application never runs another line.
// Everything this app knows about its own last moment is therefore whatever it
// had already written down.
//
// So each step of a connection attempt is written down, and cleared once the
// attempt succeeds or the app closes normally. Anything left behind on the next
// launch is, by construction, a step that was never got past -- which is the
// one fact nothing else can supply.
//
// The cost is a flash write per step, some of them on Bluetooth callbacks. That
// is why this is off unless a build asks for it; see freesla.config.js.

import { CONNECT_BREADCRUMB } from '../../freesla.config.js'

export function createBreadcrumb (storage, enabled) {
  const on = enabled === undefined ? CONNECT_BREADCRUMB === true : enabled === true

  return {
    get enabled () { return on },

    // Records a step, with how long into the attempt it happened.
    //
    // Never allowed to throw. This is a diagnostic, and a diagnostic that can
    // break a connection attempt is worse than no diagnostic: it would turn a
    // fault being investigated into a different fault.
    record (step, sinceStartMs) {
      if (!on) return
      try {
        storage.setBreadcrumb(sinceStartMs === undefined || sinceStartMs === null
          ? String(step)
          : String(step) + ' (+' + sinceStartMs + 'ms)')
      } catch (e) {
        // Deliberately silent; the caller is mid-connection.
      }
    },

    clear () {
      if (!on) return
      try {
        storage.clearBreadcrumb()
      } catch (e) {
      }
    },

    // What the previous run was doing when it stopped, or null.
    //
    // Read once at launch and cleared straight away, so it reports the run that
    // died rather than following the owner around for the rest of the day.
    //
    // A build without the instrument does not read the instrument, even to
    // find it empty. Otherwise a trail left by an earlier debugging build
    // would surface once on a shipped one -- reporting a fault its owner never
    // saw, and holding back the launch-time connect while they read it.
    take () {
      if (!on) return null
      let value = null
      try {
        value = storage.getBreadcrumb()
      } catch (e) {
        return null
      }
      try {
        storage.clearBreadcrumb()
      } catch (e) {
      }
      return value || null
    }
  }
}
