// The car link belongs to the app, not to whichever screen is in front of it.
//
// It used to belong to the page. Each screen built its own controller and its
// own transport, and tore the link down in onDestroy, which produced two faults
// with one cause:
//
//   * Walking from the main screen to Controls dropped the connection. The car
//     logged the key unsubscribing about two seconds after the last command,
//     which is exactly how long it took to tap through.
//   * The screen that had just opened built a second controller, called begin()
//     on it, and never connected it. So Controls came up reading "Tap to
//     connect" over a car that had been connected a moment earlier, and every
//     button on it answered "Not connected".
//
// Both follow from a Bluetooth link that lived and died with a widget tree.
// One controller now lives in the app's globalData instead, which is the right
// scope for it in any case: Zepp OS has no background BLE, so the link can live
// exactly as long as the app does and not one moment longer.
//
// Kept out of the pages so there is one answer to "who owns the radio", and out
// of controller.js so that file still knows nothing about Zepp OS.

export function sharedController (globalData, create) {
  if (!globalData.controller) {
    const controller = create()
    globalData.controller = controller
    // Part of construction rather than something each screen does. begin()
    // re-derives the state from storage, and a screen calling it over a live
    // connection would report DISCONNECTED at a car that is right there.
    controller.begin()
  }
  return globalData.controller
}
