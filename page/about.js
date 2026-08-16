// About: who made this, where the source lives, and what it does not promise.
//
// Reached by tapping the title on the main screen. Also the way in to the
// randomness diagnostics, which are a developer tool rather than something to
// put in front of everyone.

import { createWidget, widget, align, text_style } from '@zos/ui'
import { push } from '@zos/router'
import { px } from '@zos/utils'
import { setScrollMode, SCROLL_MODE_FREE } from '@zos/page'
import { setPageBrightTime, resetPageBrightTime } from '@zos/display'

const COLOR_TEXT = 0xffffff
const COLOR_MUTED = 0x8a8a8a
const COLOR_LINK = 0x58a6ff
const COLOR_NEUTRAL = 0x2a2a2a
const COLOR_NEUTRAL_PRESS = 0x454545

// The mark is 190x178; centring it means x = (480 - 190) / 2.
const LOGO_W = 190
const LOGO_H = 178

Page({
  build () {
    setPageBrightTime({ brightTime: 300000 })
    setScrollMode({ mode: SCROLL_MODE_FREE })

    let y = px(56)

    createWidget(widget.IMG, {
      x: px((480 - LOGO_W) / 2), y, w: px(LOGO_W), h: px(LOGO_H),
      src: 'brand/idct.png'
    })
    y += px(LOGO_H + 14)

    y = this.line(y, 'Freesla', px(30), COLOR_TEXT, px(38))
    y = this.line(y, 'Made by IDCT', px(21), COLOR_MUTED, px(30))
    y = this.line(y, 'idct.tech', px(22), COLOR_LINK, px(34))

    y += px(14)
    createWidget(widget.IMG, {
      x: px((480 - 34) / 2), y, w: px(34), h: px(34),
      src: 'icons/github.png'
    })
    y += px(42)

    y = this.line(y, 'Free and open source', px(21), COLOR_TEXT, px(30))
    y = this.line(y, 'github.com/', px(19), COLOR_LINK, px(26))
    y = this.line(y, 'ideaconnect/freesla', px(19), COLOR_LINK, px(32))

    y += px(12)
    y = this.paragraph(y,
      'Built against Tesla’s published protocol. Not affiliated with, ' +
      'endorsed by, or sponsored by Tesla, Inc.', px(18), COLOR_MUTED)

    y += px(10)
    y = this.paragraph(y, 'Icons by Font Awesome, CC BY 4.0.', px(18), COLOR_MUTED)

    y += px(18)
    createWidget(widget.BUTTON, {
      x: px(120), y, w: px(240), h: px(62),
      radius: px(31), text_size: px(22),
      normal_color: COLOR_NEUTRAL, press_color: COLOR_NEUTRAL_PRESS,
      text: 'Randomness check',
      click_func: () => push({ url: 'page/diagnostics' })
    })
    y += px(74)

    createWidget(widget.BUTTON, {
      x: px(150), y, w: px(180), h: px(60),
      radius: px(30), text_size: px(23),
      normal_color: COLOR_NEUTRAL, press_color: COLOR_NEUTRAL_PRESS,
      text: 'Back',
      click_func: () => push({ url: 'page/index' })
    })
  },

  // Single line of text. Returns the next free y, so the page composes top to
  // bottom without hand-maintained coordinates that drift apart.
  line (y, text, size, color, advance) {
    createWidget(widget.TEXT, {
      x: px(30), y, w: px(420), h: advance,
      color, text_size: size,
      align_h: align.CENTER_H, align_v: align.CENTER_V,
      text_style: text_style.NONE, text
    })
    return y + advance
  },

  // Wrapped text, sized generously: an underestimate here is what makes lines
  // collide with whatever follows.
  paragraph (y, text, size, color) {
    const height = px(Math.ceil(text.length / 34) * 26 + 16)
    createWidget(widget.TEXT, {
      x: px(46), y, w: px(388), h: height,
      color, text_size: size,
      align_h: align.CENTER_H, align_v: align.TOP,
      text_style: text_style.WRAP, text
    })
    return y + height
  },

  onDestroy () {
    resetPageBrightTime()
  }
})
