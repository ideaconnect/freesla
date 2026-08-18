import { createWidget, widget, align, text_style, prop } from '@zos/ui'
import { push } from '@zos/router'
import { setScrollMode, SCROLL_MODE_FREE } from '@zos/page'
import { setPageBrightTime, resetPageBrightTime } from '@zos/display'
import { BasePage } from '@zeppos/zml/base-page'
import * as Styles from 'zosLoader:./index.[pf].layout.js'

import { createStorage } from '../lib/zepp/storage.js'
import { createBleTransport } from '../lib/zepp/ble-transport.js'
import { createController, STATE } from '../lib/app/controller.js'
import { normaliseVin } from '../lib/app/identity.js'
import { createPhoneChannel, createSharedSecretDeriver } from '../lib/app/phone.js'
import { sharedController } from '../lib/app/session.js'
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
// replaces them once there is nothing left to say: one scrolling column of
// controls, with the lock at the top where a thumb lands without aiming.
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

// The doors, as one control. Reported together because a single door ajar is
// what matters, not which one.
const DOORS = [
  CLOSURE_FIELD.FRONT_DRIVER_DOOR, CLOSURE_FIELD.FRONT_PASSENGER_DOOR,
  CLOSURE_FIELD.REAR_DRIVER_DOOR, CLOSURE_FIELD.REAR_PASSENGER_DOOR
]

// The column below the lock, in order.
//
// A section is a heading, one button, and what the car says that panel is. The
// heading is what makes the button legible: "Trunk" over a raised-boot icon
// needs no sentence under it explaining itself.
//
// `shut` and `open` make a control a toggle: the car is asked what the panel is
// and offered the move that is left. Where only one direction exists the
// section carries `only` instead, and the reason is never a UI decision --
// no Tesla can close a frunk remotely, and closing a door is an actuator only
// the Model X has, on a panel whose obstruction sensing Tesla will not promise.
const SECTIONS = [
  {
    key: 'trunk',
    heading: 'Trunk',
    field: CLOSURE_FIELD.REAR_TRUNK,
    shut: { art: 'trunk-open', action: 'openTrunk' },
    open: { art: 'trunk-close', action: 'closeTrunk' }
  },
  { key: 'stop', stop: true },
  {
    key: 'frunk',
    heading: 'Frunk',
    field: CLOSURE_FIELD.FRONT_TRUNK,
    only: { art: 'frunk-open', action: 'openFrunk' }
  },
  {
    key: 'charge',
    heading: 'Charge port',
    field: CLOSURE_FIELD.CHARGE_PORT,
    shut: { art: 'charge-port', action: 'openChargePort' },
    open: { art: 'charge-port-close', action: 'closeChargePort' }
  },
  {
    key: 'doors',
    heading: 'Tesla X',
    group: DOORS,
    only: { art: 'doors-open', action: 'openDoors' }
  }
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
    // The driving face is longer than the display. Set unconditionally: the
    // setup face is short enough that there is nothing to scroll, and making it
    // conditional would mean setting it again when the state changes under a
    // page that has already been built.
    setScrollMode({ mode: SCROLL_MODE_FREE })

    const storage = createStorage()
    // Every request to the phone goes through here, so each one gets a deadline
    // and none of them can answer after this page is destroyed.
    const phone = createPhoneChannel({
      request: (payload) => this.request(payload),
      log: (message) => console.log('[freesla] ' + message)
    })

    // Shared with the controls screen, and outliving both. Built here only the
    // first time round; after that this picks up the live one, connection and
    // all. See lib/app/session.js for why it is not per-page.
    const controller = sharedController(getApp().globalData, () => createController({
      storage,
      createTransport: createBleTransport,
      log: (message) => console.log('[freesla] ' + message)
    }))

    controller.attach({
      // The one-time ECDH per car. Sent to the phone for the same reason the
      // keypair is: the sum takes about 87 seconds here.
      deriveSharedSecret: createSharedSecretDeriver(phone),
      onChange: () => this.render(),
      // Vehicle status arrives on its own from the car's broadcasts as well as
      // in reply to commands, so the driving screen can say what is open
      // without this watch ever asking.
      onStatusChange: () => this.renderCar()
    })

    this.state.storage = storage
    this.state.phone = phone
    this.state.controller = controller

    this.buildWidgets()
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
    //
    // Nor when the link is already up, which is the ordinary case on the way
    // back from Controls: connect() would tear down a working connection to
    // build the same one again.
    if (!lastStep && !controller.isLinked() &&
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

    // The driving column, walked down rather than positioned by hand. Widgets
    // are built once and shown by state; a scrolling list rebuilt on every
    // reading would churn memory on a watch for no benefit.
    //
    // Image buttons and not an icon laid over a coloured one: setting
    // normal_color alongside normal_src makes the flat colour paint over the
    // picture, and a separate widget on top of a button is a widget that might
    // swallow the tap. The circle, its rim and its glyph are baked into one
    // file by tools/make-icons.js.
    const D = Styles.DRIVE
    let y = D.top

    // Lock and Unlock are one control wearing two faces. Both are built here,
    // stacked, and exactly one is ever visible: swapping a button's artwork in
    // place means prop.MORE, which does not merge and has to be handed every
    // property the widget has. Two widgets and a visibility flag cannot go
    // subtly wrong the way that can.
    w.heroUnlock = this.imageButton('unlock-lg', { x: D.heroX, y, w: D.hero, h: D.hero },
      () => this.state.controller.unlock())
    w.heroLock = this.imageButton('lock-lg', { x: D.heroX, y, w: D.hero, h: D.hero },
      () => this.state.controller.lock())
    y += D.hero + D.gap

    w.heroCaption = this.centred(y, D.heroCaption.h, D.heroCaption.text_size, COLOR.TEXT, '')
    y += D.heroCaption.h + D.sectionGap

    w.sections = {}
    for (const section of SECTIONS) {
      if (section.stop) {
        // Wide and flat where everything else is a circle, so a hand reaching
        // for it in a hurry cannot land on anything else by mistake.
        w.stop = createWidget(widget.BUTTON, {
          x: D.stop.x, y, w: D.stop.w, h: D.stop.h,
          radius: D.stop.radius,
          text_size: D.stop.text_size,
          color: COLOR.TEXT,
          normal_color: COLOR.DANGER,
          press_color: COLOR.DANGER_PRESS,
          text: 'STOP',
          click_func: () => this.state.controller.stopTrunk()
        })
        y += D.stop.h + D.sectionGap
        continue
      }

      const built = { header: this.centred(y, D.header.h, D.header.text_size, COLOR.TEXT, section.heading) }
      y += D.header.h + D.gap

      const box = { x: D.buttonX, y, w: D.button, h: D.button }
      if (section.only) {
        built.only = this.imageButton(section.only.art, box, () => this.run(section.only.action))
      } else {
        built.shut = this.imageButton(section.shut.art, box, () => this.run(section.shut.action))
        built.open = this.imageButton(section.open.art, box, () => this.run(section.open.action))
      }
      y += D.button + D.gap

      built.caption = this.centred(y, D.caption.h, D.caption.text_size, COLOR.MUTED, '')
      y += D.caption.h + D.sectionGap

      w.sections[section.key] = built
    }

    // The summary of what the car is, above the whole column.
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

    // Both marks are created once and shown by state; recreating widgets on
    // every render would churn memory on a watch for no benefit.
    w.logoLarge = createWidget(widget.IMG, {
      x: Styles.LOGO_LARGE.x,
      y: Styles.LOGO_LARGE.y,
      w: Styles.LOGO_LARGE.w,
      h: Styles.LOGO_LARGE.h,
      src: 'brand/freesla.png'
    })

    // Follows the foot of the column rather than sitting at a fixed height: the
    // driving face is as long as the car has controls, and a fixed y would put
    // the mark in the middle of the list.
    w.logoSmall = createWidget(widget.IMG, {
      x: Styles.LOGO_SMALL.x,
      y: y + D.footerGap,
      w: Styles.LOGO_SMALL.w,
      h: Styles.LOGO_SMALL.h,
      src: 'brand/freesla-small.png'
    })
  },

  run (action) {
    this.state.controller.run(action)
  },

  // A centred line of text spanning the column's text width.
  centred (y, h, size, color, text) {
    return createWidget(widget.TEXT, {
      x: Styles.DRIVE.textX,
      y,
      w: Styles.DRIVE.textW,
      h,
      color,
      text_size: size,
      align_h: align.CENTER_H,
      align_v: align.CENTER_V,
      text_style: text_style.NONE,
      text
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
    w.vehicle.setProperty(prop.VISIBLE, driving)
    w.heroCaption.setProperty(prop.VISIBLE, driving)
    w.stop.setProperty(prop.VISIBLE, driving)

    for (const section of SECTIONS) {
      const built = w.sections[section.key]
      if (!built) continue
      built.header.setProperty(prop.VISIBLE, driving)
      built.caption.setProperty(prop.VISIBLE, driving)
      if (built.only) built.only.setProperty(prop.VISIBLE, driving)
    }

    // The two-faced controls are left to renderCar(): which of each pair shows
    // depends on what the car is, not on which screen this is, and driving them
    // from here would flash the wrong one on every state change.
    if (!driving) {
      w.heroUnlock.setProperty(prop.VISIBLE, false)
      w.heroLock.setProperty(prop.VISIBLE, false)
      for (const section of SECTIONS) {
        const built = w.sections[section.key]
        if (!built || !built.shut) continue
        built.shut.setProperty(prop.VISIBLE, false)
        built.open.setProperty(prop.VISIBLE, false)
      }
    }

    w.logoLarge.setProperty(prop.VISIBLE, plan.logo === 'large')
    w.logoSmall.setProperty(prop.VISIBLE, plan.logo === 'small')

    // Marked applied only once it has been. Set before the writes, a native
    // setProperty that threw would leave the cache claiming a layout that is
    // half painted, and every later render would agree there was nothing to do.
    this.state.rendered = plan

    // The car may have reported while another face was on screen, so this is
    // filled in on arrival here rather than waiting for the next broadcast.
    if (driving) this.renderCar()
  },

  // What the car is, and therefore which move each control offers.
  //
  // Separate from render() because it changes on its own schedule: status
  // arrives from the car's broadcasts, which have nothing to do with which
  // screen is up. Nothing here is printed from an assumption -- a control whose
  // panel the car has not reported keeps offering the move it opened with,
  // rather than guessing and offering the opposite of what is true.
  renderCar () {
    const controller = this.state.controller
    const w = this.state.widgets
    if (!w.sections) return
    if (!this.state.rendered || this.state.rendered.mode !== 'driving') return

    const status = controller.vehicleStatus
    // An overheard broadcast is unauthenticated, so it is marked rather than
    // presented as a reading.
    const suffix = controller.statusTrust === TRUST.OVERHEARD ? ' (unverified)' : ''

    this.renderLock(status, suffix)
    this.renderSummary(status, suffix)

    for (const section of SECTIONS) {
      const built = w.sections[section.key]
      if (!built) continue

      const state = this.panelState(section)
      const known = state !== undefined
      const shut = state === CLOSURE_STATE.CLOSED

      if (built.shut) {
        // A panel the car has not described leaves the opening move showing:
        // it is the one that is safe to offer against an unknown, since a
        // closed panel asked to close does nothing.
        built.shut.setProperty(prop.VISIBLE, !known || shut)
        built.open.setProperty(prop.VISIBLE, known && !shut)
      }

      built.caption.setProperty(prop.MORE, known
        ? { text: closureStateName(state) + suffix, color: shut ? COLOR.MUTED : COLOR.WARN }
        : { text: '', color: COLOR.MUTED })
    }
  },

  // Lock and Unlock are one control, showing the move that is left.
  //
  // A car whose state is unknown is offered Unlock. That is the move somebody
  // walking towards a car wants, it is what auto-unlock would have done
  // unasked, and unlocking a car that is already unlocked costs nothing --
  // where offering Lock against an unknown would put the wrong word under the
  // biggest button on the screen.
  renderLock (status, suffix) {
    const w = this.state.widgets
    const locked = status && status.lockState !== undefined
      ? status.lockState === VEHICLE_LOCK_STATE.LOCKED
      : true

    w.heroUnlock.setProperty(prop.VISIBLE, locked)
    w.heroLock.setProperty(prop.VISIBLE, !locked)
    w.heroCaption.setProperty(prop.MORE, {
      text: locked ? 'Unlock' : 'Lock',
      color: COLOR.TEXT
    })
  },

  // One line for the whole car, worst news first: anything standing open beats
  // the lock state and contradicts it anyway.
  renderSummary (status, suffix) {
    const w = this.state.widgets
    const controller = this.state.controller
    if (!status) return

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

  // For a group, the least-shut wins, so one door ajar is not hidden behind
  // three closed ones.
  panelState (section) {
    const controller = this.state.controller
    if (section.field !== undefined) return controller.closureState(section.field)
    if (!section.group) return undefined

    let worst
    for (const field of section.group) {
      const state = controller.closureState(field)
      if (state === undefined) continue
      if (worst === undefined || (worst === CLOSURE_STATE.CLOSED && state !== CLOSURE_STATE.CLOSED)) {
        worst = state
      }
    }
    return worst
  },

  onDestroy () {
    this.state.destroyed = true
    if (this.state.vinPoll) clearTimeout(this.state.vinPoll)
    // Anything still waiting on the phone is abandoned here. Its answer would
    // otherwise arrive seconds later and paint into widgets that are gone.
    if (this.state.phone) this.state.phone.close()
    resetPageBrightTime()
    // Stops reporting here, and nothing more. The link outlives this screen on
    // purpose: hanging up on the car because somebody opened Controls is what
    // this used to do, and the car logged it every time.
    if (this.state.controller) this.state.controller.detach()
  }
}))
