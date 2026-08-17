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
import { closureStateName, lockStateName } from '../lib/tesla/messages.js'
import {
  CLOSURE_FIELD, CLOSURE_STATE, VEHICLE_LOCK_STATE, TRUST
} from '../lib/tesla/constants.js'

const COLOR = Styles.COLOR

// Which face the screen wears in each state, and where the mark goes. Kept as
// data rather than branching in the render, so the two cannot drift apart.
//
// `mode` is the whole of it. 'setup' is a sentence and a button, because every
// state before the car is paired has something to explain. 'driving' is what
// replaces them once there is nothing left to say: three round buttons, Unlock
// in the middle of the display, which is the only spot on a round watch a thumb
// finds without looking.
//
// `logo` is 'large' while the car is still being set up, since those screens
// are mostly empty and the mark gives them a centre, and 'small' once it is
// paired, where it sits quietly under the controls.
const LAYOUT = {}
LAYOUT[STATE.NEEDS_VIN] = { mode: 'setup', primary: 'vin', logo: 'large' }
LAYOUT[STATE.NEEDS_KEY] = { mode: 'setup', primary: 'create', logo: 'large' }
LAYOUT[STATE.DISCONNECTED] = { mode: 'setup', primary: 'connect', logo: 'large' }
LAYOUT[STATE.CONNECTING] = { mode: 'setup', primary: null, logo: 'large' }
LAYOUT[STATE.NEEDS_ENROLMENT] = { mode: 'setup', primary: 'enrol', logo: 'large' }
LAYOUT[STATE.ENROLLING] = { mode: 'setup', primary: 'check', logo: null }
LAYOUT[STATE.READY] = { mode: 'driving', primary: null, logo: 'small' }
LAYOUT[STATE.BUSY] = { mode: 'driving', primary: null, logo: 'small' }
LAYOUT[STATE.ERROR] = { mode: 'setup', primary: 'retry', logo: 'large' }

const BUTTONS = {
  vin: { text: 'Check phone', color: COLOR.ACCENT, press: COLOR.ACCENT_PRESS },
  create: { text: 'Create key', color: COLOR.ACCENT, press: COLOR.ACCENT_PRESS },
  connect: { text: 'Connect', color: COLOR.LOCK, press: COLOR.LOCK_PRESS },
  enrol: { text: 'Add to car', color: COLOR.ACCENT, press: COLOR.ACCENT_PRESS },
  check: { text: 'Done, check', color: COLOR.ACCENT, press: COLOR.ACCENT_PRESS },
  retry: { text: 'Try again', color: COLOR.NEUTRAL, press: COLOR.NEUTRAL_PRESS }
}

// What the driving screen reports about the car, worst news first.
//
// A door standing open matters more than the lock state and contradicts it
// anyway -- a car with the boot up is not locked, whatever it last said -- so
// closures are read in this order and the first one that is not shut wins.
const REPORTED = [
  { field: CLOSURE_FIELD.REAR_TRUNK, label: 'Trunk' },
  { field: CLOSURE_FIELD.FRONT_TRUNK, label: 'Frunk' },
  { field: CLOSURE_FIELD.CHARGE_PORT, label: 'Charge port' },
  { field: CLOSURE_FIELD.FRONT_DRIVER_DOOR, label: 'Door' },
  { field: CLOSURE_FIELD.FRONT_PASSENGER_DOOR, label: 'Door' },
  { field: CLOSURE_FIELD.REAR_DRIVER_DOOR, label: 'Door' },
  { field: CLOSURE_FIELD.REAR_PASSENGER_DOOR, label: 'Door' }
]

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
      onChange: () => this.render(),
      // Vehicle status arrives on its own from the car's broadcasts as well as
      // in reply to commands, so the driving screen can say what is open
      // without this watch ever asking.
      onStatusChange: () => this.renderVehicle()
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

    // The driving screen's three, as artwork rather than coloured rectangles.
    //
    // Image buttons and not an icon laid over a coloured one: setting
    // normal_color alongside normal_src makes the flat colour paint over the
    // picture, and a separate widget on top of a button is a widget that might
    // swallow the tap. The circle, its rim and its glyph are baked into one
    // file by tools/make-icons.js.
    w.unlock = this.imageButton('unlock-lg', Styles.UNLOCK,
      () => this.state.controller.unlock())
    w.lock = this.imageButton('lock-sm', Styles.LOCK,
      () => this.state.controller.lock())
    w.controls = this.imageButton('controls-sm', Styles.CONTROLS,
      () => push({ url: 'page/controls' }))

    // Captions below the buttons, never over them: text drawn on top of a
    // button is text that has to be redrawn every time the button is pressed,
    // and on this runtime it is also a second widget over the tap target.
    w.capLock = this.caption(Styles.LOCK, 'Lock')
    w.capUnlock = this.caption(Styles.UNLOCK, 'Unlock')
    w.capControls = this.caption(Styles.CONTROLS, 'Controls')

    w.vehicle = createWidget(widget.TEXT, {
      x: Styles.VEHICLE.x,
      y: Styles.VEHICLE.y,
      w: Styles.VEHICLE.w,
      h: Styles.VEHICLE.h,
      color: COLOR.MUTED,
      text_size: Styles.VEHICLE.text_size,
      align_h: align.CENTER_H,
      align_v: align.CENTER_V,
      text_style: text_style.NONE,
      text: ''
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
  },

  imageButton (art, box, onPress) {
    return createWidget(widget.BUTTON, {
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      normal_src: 'btn/' + art + '_n.png',
      press_src: 'btn/' + art + '_p.png',
      click_func: onPress
    })
  },

  // A label on the shared caption baseline, as wide as the button above it.
  caption (box, text) {
    return createWidget(widget.TEXT, {
      x: box.x,
      y: Styles.CAPTIONS.y,
      w: box.w,
      h: Styles.CAPTIONS.h,
      color: COLOR.MUTED,
      text_size: Styles.CAPTIONS.text_size,
      align_h: align.CENTER_H,
      align_v: align.CENTER_V,
      text_style: text_style.NONE,
      text
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
    // This is not housekeeping. Connecting reports each step it takes -- several
    // of them from inside Bluetooth callbacks -- and a full repaint is a dozen
    // native setProperty calls. Doing all twelve to change one line of text
    // would mean the reporting of a stall on those callbacks had become a
    // twelve-fold increase in the work done on them.
    //
    // Compared by plan rather than by state: LAYOUT entries are fixed objects,
    // and two states that share one -- READY and BUSY do, field for field --
    // have nothing to repaint between them either. Keying on the state name
    // would repaint the lot on every command.
    if (this.state.rendered === plan) return

    if (plan.primary) {
      const style = BUTTONS[plan.primary]
      // Every property, not just the three that change.
      //
      // prop.MORE does not merge. Handed a partial set it takes the widget's
      // whole property block from what it was given, and on a BUTTON the result
      // is the one seen on the emulator: a button still sitting in the right
      // place, still the colour it was created with, with no text on it at all.
      // The status line above gets away with a partial set; this does not.
      w.primary.setProperty(prop.MORE, {
        x: Styles.PRIMARY.x,
        y: Styles.PRIMARY.y,
        w: Styles.PRIMARY.w,
        h: Styles.PRIMARY.h,
        radius: Styles.PRIMARY.radius,
        text_size: Styles.PRIMARY.text_size,
        color: COLOR.TEXT,
        normal_color: style.color,
        press_color: style.press,
        text: style.text
      })
    }

    const driving = plan.mode === 'driving'
    w.primary.setProperty(prop.VISIBLE, !!plan.primary)
    w.unlock.setProperty(prop.VISIBLE, driving)
    w.lock.setProperty(prop.VISIBLE, driving)
    w.controls.setProperty(prop.VISIBLE, driving)
    w.capUnlock.setProperty(prop.VISIBLE, driving)
    w.capLock.setProperty(prop.VISIBLE, driving)
    w.capControls.setProperty(prop.VISIBLE, driving)
    w.vehicle.setProperty(prop.VISIBLE, driving)
    w.logoLarge.setProperty(prop.VISIBLE, plan.logo === 'large')
    w.logoSmall.setProperty(prop.VISIBLE, plan.logo === 'small')

    // Marked applied only once it has been. Set before the writes, a native
    // setProperty that threw would leave the cache claiming a layout that is
    // half painted, and every later render would agree there was nothing to do.
    this.state.rendered = plan

    // The car may have reported while another face was on screen, so the line
    // is filled in on arrival here rather than waiting for the next broadcast.
    if (driving) this.renderVehicle()
  },

  // What the car last said about itself.
  //
  // Separate from render() because it changes on its own schedule: status
  // arrives from the car's broadcasts, which have nothing to do with which
  // button is on screen. Left blank until something has actually arrived --
  // "Locked" printed from an assumption is worse than saying nothing, since the
  // whole reason to show it is that the wearer cannot see the car.
  renderVehicle () {
    const controller = this.state.controller
    const w = this.state.widgets
    if (!w.vehicle) return
    if (!this.state.rendered || this.state.rendered.mode !== 'driving') return

    const status = controller.vehicleStatus
    if (!status) return

    // An overheard broadcast is unauthenticated, so it is marked rather than
    // presented as a reading. Worded exactly as the controls screen words it.
    const suffix = controller.statusTrust === TRUST.OVERHEARD ? ' (unverified)' : ''

    for (const item of REPORTED) {
      const state = controller.closureState(item.field)
      if (state === undefined || state === CLOSURE_STATE.CLOSED) continue
      w.vehicle.setProperty(prop.MORE, {
        text: item.label + ' ' + closureStateName(state) + suffix,
        color: COLOR.WARN
      })
      return
    }

    // Cleared rather than left alone when there is nothing to say. A boot that
    // has just been shut would otherwise leave "Trunk open" on screen for as
    // long as the app stayed open, which is the one reading nobody should be
    // able to get wrong.
    if (status.lockState === undefined) {
      w.vehicle.setProperty(prop.MORE, { text: '', color: COLOR.MUTED })
      return
    }

    const locked = status.lockState === VEHICLE_LOCK_STATE.LOCKED
    w.vehicle.setProperty(prop.MORE, {
      text: 'Car ' + lockStateName(status.lockState) + suffix,
      color: locked ? COLOR.SUCCESS : COLOR.MUTED
    })
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
