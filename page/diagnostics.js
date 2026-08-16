// Diagnostics screen.
//
// Reachable by tapping the title on the main screen. Its purpose is to answer,
// on the actual hardware, the question that decides whether this app's keys are
// trustworthy: does this watch's random number generator restart from the same
// seed every launch?
//
// Run it, close the app completely, and run it again. The verdict on the second
// run is the one that matters.

import { createWidget, widget, align, text_style, prop } from '@zos/ui'
import { push } from '@zos/router'
import { px } from '@zos/utils'
import { setPageBrightTime, resetPageBrightTime } from '@zos/display'

import { createStorage } from '../lib/zepp/storage.js'
import { probeRandomness, measureClockJitter, probeCapabilities, resetProbe, VERDICT }
  from '../lib/app/rng-probe.js'
import { derivePublicKey } from '../lib/crypto/p256.js'

const COLOR_OK = 0x3fb950
const COLOR_WARN = 0xd29922
const COLOR_BAD = 0xe5534b
const COLOR_TEXT = 0xffffff
const COLOR_MUTED = 0x8a8a8a

const VERDICT_STYLE = {}
VERDICT_STYLE[VERDICT.BASELINE] = { label: 'Baseline saved', color: COLOR_MUTED }
VERDICT_STYLE[VERDICT.VARYING] = { label: 'Seed varies', color: COLOR_OK }
VERDICT_STYLE[VERDICT.SUSPICIOUS] = { label: 'Seed space small', color: COLOR_WARN }
VERDICT_STYLE[VERDICT.FIXED_SEED] = { label: 'FIXED SEED', color: COLOR_BAD }

Page({
  state: { widgets: {}, backend: null },

  build () {
    setPageBrightTime({ brightTime: 300000 })

    const storage = createStorage()
    // The probe writes through the same backend the store uses.
    const backend = storage.probeBackend()
    this.state.backend = backend

    const w = this.state.widgets

    w.title = createWidget(widget.TEXT, {
      x: px(0), y: px(40), w: px(480), h: px(34),
      color: COLOR_MUTED, text_size: px(24),
      align_h: align.CENTER_H, align_v: align.CENTER_V,
      text_style: text_style.NONE, text: 'Randomness check'
    })

    const report = probeRandomness(backend, Math.random)
    const style = VERDICT_STYLE[report.verdict] || VERDICT_STYLE[VERDICT.BASELINE]

    w.verdict = createWidget(widget.TEXT, {
      x: px(0), y: px(78), w: px(480), h: px(44),
      color: style.color, text_size: px(32),
      align_h: align.CENTER_H, align_v: align.CENTER_V,
      text_style: text_style.NONE, text: style.label
    })

    w.detail = createWidget(widget.TEXT, {
      x: px(46), y: px(124), w: px(388), h: px(132),
      color: COLOR_TEXT, text_size: px(20),
      align_h: align.CENTER_H, align_v: align.TOP,
      text_style: text_style.WRAP, text: report.message
    })

    const caps = probeCapabilities()
    const jitter = measureClockJitter(() => Date.now(), 24)

    w.facts = createWidget(widget.TEXT, {
      x: px(46), y: px(258), w: px(388), h: px(108),
      color: COLOR_MUTED, text_size: px(19),
      align_h: align.CENTER_H, align_v: align.TOP,
      text_style: text_style.WRAP,
      text: 'runs ' + report.runs + '  ·  distinct ' + report.distinctRunsRecorded + '\n' +
        'secure RNG ' + (caps.webCrypto ? 'yes' : 'no') +
        '  ·  BigInt ' + (caps.bigint ? 'yes' : 'no') + '\n' +
        'clock deltas ' + (jitter ? jitter.distinctDeltas : '?') + ' distinct of ' +
        (jitter ? jitter.rounds : '?') + '\n' +
        'measuring key speed…'
    })

    // The scalar multiplication blocks the interpreter, so it runs after the
    // screen has been painted.
    setTimeout(() => {
      const scalar = new Uint8Array(32)
      for (let i = 0; i < 32; i++) scalar[i] = (i * 7 + 3) & 0xff

      const started = Date.now()
      derivePublicKey(scalar)
      const elapsed = Date.now() - started

      w.facts.setProperty(prop.MORE, {
        text: 'runs ' + report.runs + '  ·  distinct ' + report.distinctRunsRecorded + '\n' +
          'secure RNG ' + (caps.webCrypto ? 'yes' : 'no') +
          '  ·  BigInt ' + (caps.bigint ? 'yes' : 'no') + '\n' +
          'clock deltas ' + (jitter ? jitter.distinctDeltas : '?') + ' distinct of ' +
          (jitter ? jitter.rounds : '?') + '\n' +
          'P-256 scalar mult ' + elapsed + ' ms'
      })
      console.log('[freesla] diagnostics: verdict=' + report.verdict +
        ' runs=' + report.runs +
        ' distinct=' + report.distinctRunsRecorded +
        ' webCrypto=' + caps.webCrypto +
        ' bigint=' + caps.bigint +
        ' jitterDeltas=' + (jitter ? jitter.distinctDeltas : '?') +
        ' jitterZeros=' + (jitter ? jitter.zeroDeltas : '?') +
        ' scalarMultMs=' + elapsed +
        ' sample=' + report.sample)
    }, 80)

    // The launch sample is what actually settles the question. Shown here so it
    // can be copied into tools/invert-seed.js, which searches for a clock
    // timestamp that reproduces it; a hit proves the keys are guessable.
    const launch = (getApp().globalData || {}).launchSample
    w.sample = createWidget(widget.TEXT, {
      x: px(30), y: px(372), w: px(420), h: px(56),
      color: COLOR_MUTED, text_size: px(17),
      align_h: align.CENTER_H, align_v: align.TOP,
      text_style: text_style.WRAP,
      text: launch
        ? ('seed check:  ' + launch.at + '\n' + launch.firstMantissa + '  ' + launch.secondMantissa)
        : 'seed check unavailable'
    })

    createWidget(widget.BUTTON, {
      x: px(96), y: px(414), w: px(288), h: px(56),
      radius: px(32), text_size: px(24),
      normal_color: 0x2a2a2a, press_color: 0x454545,
      text: 'Start over',
      click_func: () => {
        resetProbe(backend)
        push({ url: 'page/index' })
      }
    })
  },

  onDestroy () {
    resetPageBrightTime()
  }
})
