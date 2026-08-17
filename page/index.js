import { createWidget, widget, align, text_style, prop } from '@zos/ui'
import { push } from '@zos/router'
import { setPageBrightTime, resetPageBrightTime } from '@zos/display'
import { BasePage } from '@zeppos/zml/base-page'
import * as Styles from 'zosLoader:./index.[pf].layout.js'

import { createStorage } from '../lib/zepp/storage.js'
import { createBleTransport } from '../lib/zepp/ble-transport.js'
import { createController, STATE } from '../lib/app/controller.js'
import { normaliseVin } from '../lib/app/identity.js'
import { createPhoneChannel, createSharedSecretDeriver } from '../lib/app/phone.js'
import { fromHex } from '../lib/util/hex.js'

const COLOR = Styles.COLOR

// Which controls each state shows, and where the mark goes. Kept as data rather
// than branching in the render, so the two cannot drift apart.
//
// `logo` is 'large' while the car is still being set up, since those screens
// are mostly empty and the mark gives them a centre, and 'small' once it is
// paired, where it sits quietly under the controls.
const LAYOUT = {}
LAYOUT[STATE.NEEDS_VIN] = { primary: 'vin', secondary: null, small: false, logo: 'large' }
LAYOUT[STATE.NEEDS_KEY] = { primary: 'create', secondary: null, small: false, logo: 'large' }
LAYOUT[STATE.DISCONNECTED] = { primary: 'connect', secondary: null, small: false, logo: 'small' }
LAYOUT[STATE.CONNECTING] = { primary: null, secondary: null, small: false, logo: 'small' }
LAYOUT[STATE.NEEDS_ENROLMENT] = { primary: 'enrol', secondary: null, small: false, logo: 'large' }
LAYOUT[STATE.ENROLLING] = { primary: 'check', secondary: null, small: false, logo: null }
LAYOUT[STATE.READY] = { primary: 'unlock', secondary: 'lock', small: true, logo: 'small' }
LAYOUT[STATE.BUSY] = { primary: 'unlock', secondary: 'lock', small: true, logo: 'small' }
LAYOUT[STATE.ERROR] = { primary: 'retry', secondary: null, small: false, logo: 'small' }

const BUTTONS = {
  vin: { text: 'Check phone', color: COLOR.ACCENT, press: COLOR.ACCENT_PRESS },
  create: { text: 'Create key', color: COLOR.ACCENT, press: COLOR.ACCENT_PRESS },
  connect: { text: 'Connect', color: COLOR.LOCK, press: COLOR.LOCK_PRESS },
  enrol: { text: 'Add to car', color: COLOR.ACCENT, press: COLOR.ACCENT_PRESS },
  check: { text: 'Done, check', color: COLOR.ACCENT, press: COLOR.ACCENT_PRESS },
  retry: { text: 'Try again', color: COLOR.NEUTRAL, press: COLOR.NEUTRAL_PRESS },
  unlock: { text: 'Unlock', color: COLOR.UNLOCK, press: COLOR.UNLOCK_PRESS },
  lock: { text: 'Lock', color: COLOR.LOCK, press: COLOR.LOCK_PRESS }
}

Page(BasePage({
  state: {
    controller: null,
    storage: null,
    phone: null,
    widgets: {},
    vinPoll: null,
    destroyed: false,
    // The state the buttons and logo were last laid out for; see render().
    rendered: null
  },

  build () {
    // BLE only runs while the app is foregrounded and the screen is lit; the
    // system otherwise closes the app about ten seconds after the screen dims.
    setPageBrightTime({ brightTime: 300000 })

    const storage = createStorage()
    // Every request to the phone goes through here, so each one gets a deadline
    // and none of them can answer after this page is destroyed.
    const phone = createPhoneChannel({
      request: (payload) => this.request(payload),
      log: (message) => console.log('[freesla] ' + message)
    })

    const controller = createController({
      storage,
      createTransport: createBleTransport,
      // The one-time ECDH per car. Sent to the phone for the same reason the
      // keypair is: the sum takes about 87 seconds here.
      deriveSharedSecret: createSharedSecretDeriver(phone),
      log: (message) => console.log('[freesla] ' + message),
      onChange: () => this.render()
    })
    this.state.storage = storage
    this.state.phone = phone
    this.state.controller = controller

    this.buildWidgets()
    controller.begin()
    this.render()

    // If the previous run stopped part way through a connection, say where.
    //
    // Nothing else can: a watchdog reset takes the screen and the console with
    // it, so the only account of the last moment is the one that was written
    // down before it. Reported on screen as well as to the log, because the
    // console is not always attached at the moment it matters -- and reported
    // before anything below starts a fresh attempt over the top of it.
    const lastStep = controller.lastConnectStep()
    if (lastStep) {
      console.log('[freesla] the previous run stopped at: ' + lastStep)
      this.setStatus('Last run stopped at ' + lastStep + '. Tap to try again.', COLOR.ERROR)
    }


    // The VIN may have been entered on the phone before this app was ever
    // opened, so go and fetch it. Failure is expected and harmless when no
    // phone is nearby; the watch does not need one to operate.
    if (controller.state === STATE.NEEDS_VIN) this.pollForVin()

    // Connecting immediately means a configured watch is usually ready by the
    // time the wearer reaches the car. Done for a key still waiting to be
    // enrolled too: that screen's only action needs the car in range, and
    // starting the scan now means it usually already is.
    //
    // Not after a run that stopped mid-connection, though. If connecting is
    // what restarted the watch, then connecting again the moment it comes back
    // up is a boot loop -- one the wearer cannot get out of, because the app
    // never stays alive long enough to be told to stop. It also happens to
    // erase the only evidence of the fault, by painting over it. So the tap is
    // required, once, and the reason for it stays on the screen until then.
    if (!lastStep &&
        (controller.state === STATE.DISCONNECTED ||
         controller.state === STATE.NEEDS_ENROLMENT)) {
      controller.connect()
    }
  },

  // Asks repeatedly rather than once.
  //
  // The single attempt this replaces had to win a race it usually lost: the
  // companion service on the phone is not running until something wants it, and
  // the link to the phone is still being established while this page is being
  // built. One request into that gap is answered by nobody, and the watch then
  // sat on "no VIN" for as long as the app stayed open, however long ago the
  // owner had actually typed one in.
  pollForVin () {
    let attempt = 0

    const ask = () => {
      if (this.state.destroyed) return
      if (this.state.controller.state !== STATE.NEEDS_VIN) return

      attempt++
      this.requestVin(false)

      // Backs off rather than hammering the link, and stops well before it
      // could be mistaken for activity: past this point the owner has the
      // Check phone button, which says what it is doing.
      if (attempt < 5) this.state.vinPoll = setTimeout(ask, attempt * 3000)
    }

    ask()
  },

  // `announce` reports progress and failure on screen. Off for the automatic
  // polling, where no phone in range is the normal case and saying so would
  // bury the instruction the wearer actually needs to read.
  requestVin (announce) {
    if (announce) this.setStatus('Asking your phone…', COLOR.TEXT)

    this.state.phone.ask('GET_VIN', { timeoutMs: 12000 }, (err, data) => {
      if (!err && data && data.vin && this.applyVin(data.vin)) return
      if (announce) {
        this.setStatus('No VIN from your phone yet. Enter it in Freesla’s ' +
          'settings in the Zepp app, then tap Check phone.', COLOR.ERROR)
      }
    })
  },

  // Returns whether the watch now holds this VIN, so a manual check can tell a
  // phone that answered with nothing usable from one that answered properly.
  applyVin (value) {
    const vin = normaliseVin(value)
    if (!vin) return false
    if (vin === this.state.storage.getVin()) return true

    this.state.controller.setVin(vin)
    if (this.state.controller.state === STATE.DISCONNECTED ||
        this.state.controller.state === STATE.NEEDS_ENROLMENT) {
      this.state.controller.connect()
    }
    return true
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
    // New widgets carry none of the old ones' properties, so whatever the
    // cache below believes is already painted, is not.
    this.state.rendered = null
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
      case 'vin':
        this.requestVin(true)
        break
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

  // The key is built on the phone and sent over.
  //
  // Both machines run the same curve code, but the phone finishes in about ten
  // milliseconds and this watch takes some ninety seconds -- an interpreter
  // gap, not an algorithmic one. Ninety seconds of setup that looks like a hang
  // is not something to ask of anyone, so the work goes where it is quick.
  //
  // There is no watch-side fallback. Building a key here would need a secure
  // generator this platform does not have and a scalar multiplication it cannot
  // afford, and a key made without the first is worse than no key at all --
  // the car trusts a guessable one exactly like a real one.
  createKey () {
    this.setStatus('Asking your phone…', COLOR.TEXT)

    this.state.phone.ask('GET_KEYPAIR', {}, (err, data) => {
      if (err) {
        this.setStatus('Phone not connected. Open the Zepp app on your phone, ' +
          'then tap Create key again.', COLOR.ERROR)
        return
      }

      if (data && data.quality === 'strong' && data.privateHex && data.publicHex) {
        this.setStatus('Creating key…', COLOR.TEXT)
        this.state.controller.installKeyPair(fromHex(data.privateHex), fromHex(data.publicHex))
        return
      }

      // The phone answered and cannot help. Reported through the controller so
      // it survives the next render: written straight to the widget it would be
      // wiped by any repaint the controller triggers afterwards.
      const reason = data && data.quality === 'unavailable'
        ? 'Your phone has no secure random source, so a safe key cannot be made.'
        : 'Your phone could not create a key. Update the Zepp app on your ' +
          'phone, then tap Create key again.'

      console.log('[freesla] phone could not make a keypair (' +
        (data && data.quality) + ')')
      this.state.controller.keyUnavailable(reason)
    })
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

    // Everything below is decided by the layout alone, so when only the caption
    // has moved there is nothing below to redo.
    //
    // This is not housekeeping. Connecting now reports each step it takes --
    // several of them from inside Bluetooth callbacks -- and a full repaint is
    // seven native setProperty calls. Doing all seven to change one line of
    // text would mean the reporting of a stall on those callbacks had become a
    // seven-fold increase in the work done on them.
    //
    // Compared by plan rather than by state: LAYOUT entries are fixed objects,
    // and two states that share one -- READY and BUSY do, field for field --
    // have nothing to repaint between them either. Keying on the state name
    // would repaint all seven properties on every command.
    if (this.state.rendered === plan) return

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

    // Marked applied only once it has been. Set before the writes, a native
    // setProperty that threw would leave the cache claiming a layout that is
    // half painted, and every later render would agree there was nothing to do.
    this.state.rendered = plan
  },

  onDestroy () {
    this.state.destroyed = true
    if (this.state.vinPoll) clearTimeout(this.state.vinPoll)
    // Anything still waiting on the phone is abandoned here. Its answer would
    // otherwise arrive seconds later and paint into widgets that are gone.
    if (this.state.phone) this.state.phone.close()
    resetPageBrightTime()
    if (this.state.controller) {
      // Closing the app is not a crash. disconnect() drops the trail too, but
      // this covers the case where there is no live connection to drop.
      this.state.controller.forgetConnectStep()
      this.state.controller.disconnect()
    }
  }
}))
