// The app object, and the one place the phone link is established.
//
// Wrapping in BaseApp is not cosmetic. ZML's page messaging reads its transport
// from getApp()._options.globalData.messaging, and it is BaseApp's onCreate
// that puts it there and connects it. With a bare App() that property is
// undefined, so every page throws "cannot read property 'onCall' of undefined"
// on init and silently loses the whole phone link: no request from the watch
// ever reaches the phone, and nothing the phone pushes ever arrives. The VIN
// then cannot cross, however correct both ends are.
import { BaseApp } from '@zeppos/zml/base-app'

import { captureLaunchSample } from './lib/app/rng-probe.js'

// Taken before anything else can touch Math.random, so these really are the
// first two outputs of this JS context. The diagnostics screen reports them and
// tools/invert-seed.js uses them to test whether the generator is seeded from
// the clock -- which would make every key this app creates guessable.
//
// ZML is imported above and so evaluates first, but it draws no randomness at
// module scope; it only does so per message, long after this line.
const LAUNCH_SAMPLE = captureLaunchSample()

App(BaseApp({
  globalData: {
    launchSample: LAUNCH_SAMPLE,
    // The one controller, and with it the one Bluetooth link, shared by every
    // screen. Filled in by lib/app/session.js the first time a page asks.
    // Here rather than in a page because a page is the wrong lifetime for it:
    // see the note at the top of that file.
    controller: null
  },

  onCreate () {
    console.log('[freesla] launch sample at=' + LAUNCH_SAMPLE.at +
      ' r1=' + LAUNCH_SAMPLE.firstMantissa +
      ' r2=' + LAUNCH_SAMPLE.secondMantissa)
  },

  // The only place the car is hung up on.
  //
  // Closing the app deliberately is not a crash, so the breadcrumb goes with
  // it; otherwise every ordinary exit mid-connection would be reported as one
  // by the next launch, and that report suppresses the automatic reconnect.
  onDestroy () {
    const controller = (getApp().globalData || {}).controller
    if (!controller) return
    controller.forgetConnectStep()
    controller.disconnect()
  }
}))
