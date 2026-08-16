import { createWidget, widget, align, text_style, prop } from '@zos/ui'
import { push } from '@zos/router'
import { setPageBrightTime, resetPageBrightTime } from '@zos/display'
import { BasePage } from '@zeppos/zml/base-page'
import * as Styles from 'zosLoader:./index.[pf].layout.js'

import { createStorage } from '../lib/zepp/storage.js'
import { createBleTransport } from '../lib/zepp/ble-transport.js'
import { createController, STATE } from '../lib/app/controller.js'
import { normaliseVin } from '../lib/app/identity.js'
import { fromHex } from '../lib/util/hex.js'

const COLOR = Styles.COLOR

// Which control set each state shows. Keeping this as data rather than
// branching in the render keeps the two in step as states are added.
// Which controls each state shows, and where the mark goes. Kept as data rather
// than branching in the render, so the two cannot drift apart.
//
// `logo` is 'large' while the car is still being set up — those screens are
// mostly empty and the mark gives them a centre — and 'small' once it is
// paired, where it sits quietly under the controls.
const LAYOUT = {}
LAYOUT[STATE.NEEDS_VIN] = { primary: null, secondary: null, small: false, logo: 'large' }
LAYOUT[STATE.NEEDS_KEY] = { primary: 'create', secondary: null, small: false, logo: 'large' }
LAYOUT[STATE.GENERATING_KEY] = { primary: null, secondary: null, small: false, logo: null }
LAYOUT[STATE.DISCONNECTED] = { primary: 'connect', secondary: null, small: false, logo: 'small' }
LAYOUT[STATE.CONNECTING] = { primary: null, secondary: null, small: false, logo: 'small' }
LAYOUT[STATE.NEEDS_ENROLMENT] = { primary: 'enrol', secondary: null, small: false, logo: 'large' }
LAYOUT[STATE.ENROLLING] = { primary: 'check', secondary: null, small: false, logo: null }
LAYOUT[STATE.READY] = { primary: 'unlock', secondary: 'lock', small: true, logo: 'small' }
LAYOUT[STATE.BUSY] = { primary: 'unlock', secondary: 'lock', small: true, logo: 'small' }
LAYOUT[STATE.ERROR] = { primary: 'retry', secondary: null, small: false, logo: 'small' }

const BUTTONS = {
  create: { text: 'Create key', color: COLOR.ACCENT, press: COLOR.ACCENT_PRESS },
  connect: { text: 'Connect', color: COLOR.LOCK, press: COLOR.LOCK_PRESS },
  enrol: { text: 'Add to car', color: COLOR.ACCENT, press: COLOR.ACCENT_PRESS },
  check: { text: 'Done — check', color: COLOR.ACCENT, press: COLOR.ACCENT_PRESS },
  retry: { text: 'Try again', color: COLOR.NEUTRAL, press: COLOR.NEUTRAL_PRESS },
  unlock: { text: 'Unlock', color: COLOR.UNLOCK, press: COLOR.UNLOCK_PRESS },
  lock: { text: 'Lock', color: COLOR.LOCK, press: COLOR.LOCK_PRESS }
}

Page(BasePage({
  state: {
    controller: null,
    storage: null,
    widgets: {},
    // Distinguishes "no phone in range" from "phone has no secure generator",
    // which need different fixes from the owner.
    entropyProblem: null
  },

  build () {
    // BLE only runs while the app is foregrounded and the screen is lit; the
    // system otherwise closes the app about ten seconds after the screen dims.
    setPageBrightTime({ brightTime: 300000 })

    const storage = createStorage()
    const controller = createController({
      storage,
      createTransport: createBleTransport,
      log: (message) => console.log('[freesla] ' + message),
      onChange: () => this.render()
    })
    this.state.storage = storage
    this.state.controller = controller

    this.buildWidgets()
    controller.begin()
    this.render()

    // The VIN may have been entered on the phone before this app was ever
    // opened, so ask for it once. Failure is expected and harmless when no
    // phone is nearby; the watch does not need one to operate.
    if (controller.state === STATE.NEEDS_VIN) this.requestVin()

    // Connecting immediately means a configured watch is usually ready by the
    // time the wearer reaches the car.
    if (controller.state === STATE.DISCONNECTED) controller.connect()
  },

  requestVin () {
    try {
      this.request({ method: 'GET_VIN' })
        .then((data) => {
          if (data && data.vin) this.applyVin(data.vin)
        })
        .catch(() => {})
    } catch (e) {
      // No phone connected; the watch carries on with whatever it has stored.
    }
  },

  applyVin (value) {
    const vin = normaliseVin(value)
    if (!vin) return
    if (vin === this.state.storage.getVin()) return

    this.state.controller.setVin(vin)
    if (this.state.controller.state === STATE.DISCONNECTED) this.state.controller.connect()
  },

  // Pushed from the phone when the VIN changes in settings.
  onCall (data) {
    if (!data) return
    if (data.method === 'SET_VIN') {
      this.applyVin(data.vin)
    } else if (data.method === 'SET_AUTO_UNLOCK') {
      this.state.controller.setAutoUnlock(!!data.enabled)
    } else if (data.method === 'FORGET_KEY') {
      this.state.controller.disconnect()
      this.state.storage.reset()
      this.state.controller.begin()
    }
  },

  buildWidgets () {
    const w = this.state.widgets

    // A button rather than a label so the diagnostics screen has a way in
    // without cluttering the main controls. Painted flat, so it reads as text.
    w.title = createWidget(widget.BUTTON, {
      x: Styles.TITLE.x,
      y: Styles.TITLE.y,
      w: Styles.TITLE.w,
      h: Styles.TITLE.h,
      radius: 0,
      normal_color: COLOR.BACKGROUND,
      press_color: COLOR.NEUTRAL,
      text_size: Styles.TITLE.text_size,
      text: 'Freesla',
      click_func: () => push({ url: 'page/about' })
    })

    w.status = createWidget(widget.TEXT, {
      x: Styles.STATUS.x,
      y: Styles.STATUS.y,
      w: Styles.STATUS.w,
      h: Styles.STATUS.h,
      color: COLOR.TEXT,
      text_size: Styles.STATUS.text_size,
      align_h: align.CENTER_H,
      align_v: align.CENTER_V,
      text_style: text_style.WRAP,
      text: ''
    })

    w.primary = createWidget(widget.BUTTON, {
      x: Styles.PRIMARY.x,
      y: Styles.PRIMARY.y,
      w: Styles.PRIMARY.w,
      h: Styles.PRIMARY.h,
      radius: Styles.PRIMARY.radius,
      text_size: Styles.PRIMARY.text_size,
      normal_color: COLOR.UNLOCK,
      press_color: COLOR.UNLOCK_PRESS,
      text: '',
      click_func: () => this.onPrimary()
    })

    w.secondary = createWidget(widget.BUTTON, {
      x: Styles.SECONDARY.x,
      y: Styles.SECONDARY.y,
      w: Styles.SECONDARY.w,
      h: Styles.SECONDARY.h,
      radius: Styles.SECONDARY.radius,
      text_size: Styles.SECONDARY.text_size,
      normal_color: COLOR.LOCK,
      press_color: COLOR.LOCK_PRESS,
      text: 'Lock',
      click_func: () => this.state.controller.lock()
    })

    // Both sizes are created once and shown by state; recreating widgets on
    // every render would churn memory on a watch for no benefit.
    w.logoLarge = createWidget(widget.IMG, {
      x: Styles.LOGO_LARGE.x,
      y: Styles.LOGO_LARGE.y,
      w: Styles.LOGO_LARGE.w,
      h: Styles.LOGO_LARGE.h,
      src: 'brand/freesla.png'
    })

    w.logoSmall = createWidget(widget.IMG, {
      x: Styles.LOGO_SMALL.x,
      y: Styles.LOGO_SMALL.y,
      w: Styles.LOGO_SMALL.w,
      h: Styles.LOGO_SMALL.h,
      src: 'brand/freesla-small.png'
    })

    w.controls = createWidget(widget.BUTTON, {
      x: Styles.CONTROLS.x,
      y: Styles.CONTROLS.y,
      w: Styles.CONTROLS.w,
      h: Styles.CONTROLS.h,
      radius: Styles.CONTROLS.radius,
      text_size: Styles.CONTROLS.text_size,
      normal_color: COLOR.NEUTRAL,
      press_color: COLOR.NEUTRAL_PRESS,
      text: 'Controls',
      click_func: () => push({ url: 'page/controls' })
    })
  },

  onPrimary () {
    const controller = this.state.controller
    const plan = LAYOUT[controller.state]
    if (!plan || !plan.primary) return

    switch (plan.primary) {
      case 'create':
        this.createKey()
        break
      case 'connect':
      case 'retry':
        controller.connect()
        break
      case 'enrol':
        controller.requestEnrolment()
        break
      case 'check':
        controller.checkEnrolment()
        break
      case 'unlock':
        controller.unlock()
        break
    }
  },

  // Key generation is the one moment where randomness quality is decided for
  // good, so the phone is asked for entropy first. The watch has no secure
  // generator of its own, and the resulting key guards a car.
  createKey () {
    const controller = this.state.controller
    let done = false

    const finish = (entropy) => {
      if (done) return
      done = true

      // The scalar multiplication blocks the interpreter for a noticeable
      // moment, so the progress text is painted and the work deferred a tick,
      // or the screen would sit frozen on the previous frame.
      if (!entropy) {
        // Refused rather than degraded: without the phone there is no source of
        // randomness on this watch worth building a car key from.
        this.setStatus(this.state.entropyProblem === 'unavailable'
          ? 'Your phone has no secure random source, so a safe key cannot be made.'
          : 'Phone not connected. Open the Zepp app on your phone, then tap ' +
            'Create key again.', COLOR.ERROR)
        return
      }

      this.setStatus('Creating key…', COLOR.TEXT)
      setTimeout(() => controller.generateKey(entropy), 60)
    }

    this.setStatus('Waiting for your phone…', COLOR.TEXT)
    // Do not wait indefinitely: with no phone in range the request never
    // settles, and setup would appear to hang. Generous, since this happens
    // exactly once and a round trip goes over Bluetooth.
    setTimeout(() => finish(null), 12000)

    try {
      this.request({ method: 'GET_ENTROPY', bytes: 48 })
        .then((data) => {
          // Only a real generator counts. The phone falling back to
          // Math.random would be no better than the watch doing so.
          const strong = data && data.quality === 'strong' && data.hex
          if (data && !strong) {
            this.state.entropyProblem = data.quality
            console.log('[freesla] phone entropy rejected: ' + data.quality + ' from ' + data.source)
          }
          finish(strong ? fromHex(data.hex) : null)
        })
        .catch(() => finish(null))
    } catch (e) {
      finish(null)
    }
  },

  setStatus (message, color) {
    this.state.widgets.status.setProperty(prop.MORE, {
      text: message,
      color: color === undefined ? COLOR.TEXT : color
    })
  },

  render () {
    const controller = this.state.controller
    const w = this.state.widgets
    const plan = LAYOUT[controller.state] || LAYOUT[STATE.ERROR]

    let color = COLOR.TEXT
    if (controller.state === STATE.ERROR) color = COLOR.ERROR
    else if (controller.state === STATE.READY) color = COLOR.SUCCESS
    this.setStatus(controller.detail || controller.state, color)

    if (plan.primary) {
      const style = BUTTONS[plan.primary]
      w.primary.setProperty(prop.MORE, {
        text: style.text,
        normal_color: style.color,
        press_color: style.press
      })
    }
    w.primary.setProperty(prop.VISIBLE, !!plan.primary)
    w.secondary.setProperty(prop.VISIBLE, !!plan.secondary)
    w.controls.setProperty(prop.VISIBLE, plan.small)
    w.logoLarge.setProperty(prop.VISIBLE, plan.logo === 'large')
    w.logoSmall.setProperty(prop.VISIBLE, plan.logo === 'small')
  },

  onDestroy () {
    resetPageBrightTime()
    if (this.state.controller) this.state.controller.disconnect()
  }
}))
