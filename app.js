import { captureLaunchSample } from './lib/app/rng-probe.js'

// Taken before anything else can touch Math.random, so these really are the
// first two outputs of this JS context. The diagnostics screen reports them and
// tools/invert-seed.js uses them to test whether the generator is seeded from
// the clock -- which would make every key this app creates guessable.
const LAUNCH_SAMPLE = captureLaunchSample()

App({
  globalData: {
    launchSample: LAUNCH_SAMPLE
  },

  onCreate () {
    console.log('[freesla] launch sample at=' + LAUNCH_SAMPLE.at +
      ' r1=' + LAUNCH_SAMPLE.firstMantissa +
      ' r2=' + LAUNCH_SAMPLE.secondMantissa)
  },

  onDestroy () {}
})
