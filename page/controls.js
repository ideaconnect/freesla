// Closure controls: boot, frunk, doors, charge port.
//
// Kept off the main screen deliberately. Lock and unlock are what you reach for
// walking to the car; these move physical panels, and a button that pops a
// bonnet should not sit under a thumb that was aiming for Unlock.
//
// Two rules shape this screen:
//
//   * Anything irreversible or hazardous takes two taps. Opening the boot is
//     reversible and harmless, so it stays a single tap. Opening the frunk is
//     one tap away from a bonnet nobody can shut remotely -- no Tesla has a
//     remote frunk close -- so it asks first. Same for the doors, which leave
//     the car physically unsecured.
//   * Nothing here ever claims the car moved. VCSEC acknowledges a command with
//     silence, which proves it was accepted, not that a motor turned. So the
//     wording is "sent", never "done".
//
// Laid out as a single column 320px wide. The inscribed square of a 480px round
// display is only 339px, so a two-column grid puts its outer cells in the
// clipped corner arc at some scroll positions; one narrow column is legible
// wherever it happens to sit.

import { createWidget, widget, align, text_style, prop } from '@zos/ui'
import { push } from '@zos/router'
import { px } from '@zos/utils'
import { setScrollMode, SCROLL_MODE_FREE } from '@zos/page'
import { setPageBrightTime, resetPageBrightTime } from '@zos/display'

import { createStorage } from '../lib/zepp/storage.js'
import { createBleTransport } from '../lib/zepp/ble-transport.js'
import { createController, STATE } from '../lib/app/controller.js'
import { closureStateName, lockStateName } from '../lib/tesla/messages.js'
import {
  CLOSURE_FIELD, CLOSURE_STATE, VEHICLE_LOCK_STATE, TRUST
} from '../lib/tesla/constants.js'

const COLOR_TEXT = 0xffffff
const COLOR_MUTED = 0x8a8a8a
const COLOR_WARN = 0xd29922
const COLOR_ERROR = 0xe5534b
const COLOR_OK = 0x3fb950

const ICON = 120
const ICON_X = px(88)
const LABEL_X = px(216)
const LABEL_W = px(190)
const ROW_TOP = px(150)
const ROW_PITCH = px(136)
const CONFIRM_WINDOW_MS = 5000

// Ordered by how confident we are that a given car will actually obey, and by
// how often it gets used. Each caption says what the control really does rather
// than what we wish it did.
const CONTROLS = [
  {
    name: 'trunk-open',
    label: 'Trunk',
    caption: 'open',
    action: 'openTrunk',
    closure: CLOSURE_FIELD.REAR_TRUNK
  },
  {
    name: 'trunk-close',
    label: 'Trunk',
    caption: 'close · powered liftgate only',
    action: 'closeTrunk',
    confirm: true,
    closure: CLOSURE_FIELD.REAR_TRUNK
  },
  {
    name: 'frunk-open',
    label: 'Frunk',
    caption: 'open · cannot be closed remotely',
    action: 'openFrunk',
    confirm: true,
    closure: CLOSURE_FIELD.FRONT_TRUNK
  },
  {
    name: 'doors-open',
    label: 'Doors',
    caption: 'unlatch · Model X swings them',
    action: 'openDoors',
    confirm: true,
    // Reports the worst state across all four, so one door ajar shows.
    closureGroup: [
      CLOSURE_FIELD.FRONT_DRIVER_DOOR, CLOSURE_FIELD.FRONT_PASSENGER_DOOR,
      CLOSURE_FIELD.REAR_DRIVER_DOOR, CLOSURE_FIELD.REAR_PASSENGER_DOOR
    ]
  },
  {
    // The counterpart to opening the doors is locking the car, not driving the
    // doors shut -- almost no Tesla can pull a door closed. A car with a door
    // standing open refuses to lock and says why, which the status line shows.
    name: 'lock',
    label: 'Lock',
    caption: 'secure the car',
    action: 'lock'
  },
  {
    name: 'charge-port',
    label: 'Charge port',
    caption: 'open',
    action: 'openChargePort',
    closure: CLOSURE_FIELD.CHARGE_PORT
  },
  {
    name: 'stop',
    label: 'Stop',
    caption: 'halt a moving panel',
    action: 'stopTrunk'
  }
]

Page({
  state: {
    controller: null,
    status: null,
    captions: {},
    armed: null,
    armedTimer: null
  },

  build () {
    setPageBrightTime({ brightTime: 300000 })
    setScrollMode({ mode: SCROLL_MODE_FREE })

    const controller = createController({
      storage: createStorage(),
      createTransport: createBleTransport,
      log: (message) => console.log('[freesla] ' + message),
      onChange: (state, detail) => this.showStatus(state, detail),
      onStatusChange: () => this.renderClosureState()
    })
    this.state.controller = controller
    controller.begin()

    createWidget(widget.TEXT, {
      x: px(0), y: px(44), w: px(480), h: px(34),
      color: COLOR_MUTED, text_size: px(24),
      align_h: align.CENTER_H, align_v: align.CENTER_V,
      text_style: text_style.NONE, text: 'Controls'
    })

    createWidget(widget.TEXT, {
      x: px(70), y: px(80), w: px(340), h: px(28),
      color: COLOR_MUTED, text_size: px(17),
      align_h: align.CENTER_H, align_v: align.CENTER_V,
      text_style: text_style.NONE, text: 'Park the car first'
    })

    this.state.status = createWidget(widget.TEXT, {
      x: px(70), y: px(108), w: px(340), h: px(36),
      color: COLOR_TEXT, text_size: px(19),
      align_h: align.CENTER_H, align_v: align.CENTER_V,
      text_style: text_style.NONE, text: ''
    })

    CONTROLS.forEach((control, index) => this.addRow(control, index))

    const bottom = ROW_TOP + ROW_PITCH * CONTROLS.length + px(10)
    createWidget(widget.BUTTON, {
      x: px(140), y: bottom, w: px(200), h: px(64),
      radius: px(32), text_size: px(24),
      normal_color: 0x2a2a2a, press_color: 0x454545,
      text: 'Back',
      click_func: () => push({ url: 'page/index' })
    })

    this.showStatus(controller.state, controller.detail)
  },

  addRow (control, index) {
    const y = ROW_TOP + ROW_PITCH * index

    // Image-only button. Setting normal_color alongside normal_src makes the
    // flat colour paint over the artwork.
    createWidget(widget.BUTTON, {
      x: ICON_X, y,
      w: px(ICON), h: px(ICON),
      normal_src: 'btn/' + control.name + '_n.png',
      press_src: 'btn/' + control.name + '_p.png',
      click_func: () => this.activate(control)
    })

    createWidget(widget.TEXT, {
      x: LABEL_X, y: y + px(24), w: LABEL_W, h: px(34),
      color: COLOR_TEXT, text_size: px(27),
      align_h: align.LEFT, align_v: align.CENTER_V,
      text_style: text_style.NONE, text: control.label
    })

    this.state.captions[control.name] = createWidget(widget.TEXT, {
      x: LABEL_X, y: y + px(58), w: LABEL_W, h: px(44),
      color: COLOR_MUTED, text_size: px(17),
      align_h: align.LEFT, align_v: align.TOP,
      text_style: text_style.WRAP, text: control.caption
    })
  },

  activate (control) {
    if (!control.confirm) {
      this.disarm()
      this.state.controller.run(control.action)
      return
    }

    if (this.state.armed === control.name) {
      this.disarm()
      this.state.controller.run(control.action)
      return
    }

    this.arm(control)
  },

  arm (control) {
    this.disarm()
    this.state.armed = control.name
    this.setCaption(control.name, 'Tap again to confirm', COLOR_WARN)

    this.state.armedTimer = setTimeout(() => {
      this.state.armedTimer = null
      this.disarm()
    }, CONFIRM_WINDOW_MS)
  },

  disarm () {
    if (this.state.armedTimer) {
      clearTimeout(this.state.armedTimer)
      this.state.armedTimer = null
    }

    const armed = this.state.armed
    if (!armed) return
    this.state.armed = null

    for (const control of CONTROLS) {
      if (control.name === armed) this.setCaption(armed, control.caption, COLOR_MUTED)
    }
  },

  setCaption (name, text, color) {
    const caption = this.state.captions[name]
    if (caption) caption.setProperty(prop.MORE, { text, color })
  },

  // Replaces each row's static note with what the car says once it has said
  // anything, and marks how much that can be believed.
  renderClosureState () {
    const controller = this.state.controller
    const status = controller.vehicleStatus
    if (!status) return

    const overheard = controller.statusTrust === TRUST.OVERHEARD

    for (const control of CONTROLS) {
      if (this.state.armed === control.name) continue

      const state = this.worstState(control, controller)
      if (state === undefined) continue

      // Anything not shut is worth flagging in amber; an unverified reading is
      // dimmed and marked rather than presented as fact.
      const shut = state === CLOSURE_STATE.CLOSED
      const text = closureStateName(state) + (overheard ? ' (unverified)' : '')
      this.setCaption(control.name, text, shut ? COLOR_MUTED : COLOR_WARN)
    }

    if (status.lockState !== undefined) {
      const locked = status.lockState === VEHICLE_LOCK_STATE.LOCKED
      this.setCaption('lock',
        lockStateName(status.lockState) + (overheard ? ' (unverified)' : ''),
        locked ? COLOR_OK : COLOR_MUTED)
    }
  },

  // For a group of closures, the least-shut wins, so a single door ajar is not
  // hidden behind three closed ones.
  worstState (control, controller) {
    if (control.closure !== undefined) return controller.closureState(control.closure)
    if (!control.closureGroup) return undefined

    let worst
    for (const field of control.closureGroup) {
      const state = controller.closureState(field)
      if (state === undefined) continue
      if (worst === undefined || (worst === CLOSURE_STATE.CLOSED && state !== CLOSURE_STATE.CLOSED)) {
        worst = state
      }
    }
    return worst
  },

  showStatus (state, detail) {
    if (!this.state.status) return

    let color = COLOR_TEXT
    if (state === STATE.ERROR) color = COLOR_ERROR
    else if (state === STATE.READY) color = COLOR_OK

    this.state.status.setProperty(prop.MORE, { text: detail || '', color })
  },

  onDestroy () {
    // The confirm timer must not outlive the screen, or it would fire against a
    // widget that no longer exists.
    this.disarm()
    resetPageBrightTime()
    if (this.state.controller) this.state.controller.disconnect()
  }
})
