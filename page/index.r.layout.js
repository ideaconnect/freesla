// Layout for the round 480px target. px() rescales for the 466px T-Rex 3 Pro,
// so both sizes share one definition.
//
// Two constraints drive every number here. A 480px circle only guarantees a
// 339px-wide inscribed square, so nothing wide may sit near the top or bottom
// edge. And the status line carries arbitrary vehicle messages, so its box is
// sized for three wrapped lines -- an overflowing status is what puts text on
// top of the buttons underneath.

import { px } from '@zos/utils'

export const COLOR = {
  BACKGROUND: 0x000000,
  TEXT: 0xffffff,
  MUTED: 0x8a8a8a,
  ERROR: 0xe5534b,
  WARN: 0xd29922,
  SUCCESS: 0x3fb950,
  UNLOCK: 0x1f7a3d,
  UNLOCK_PRESS: 0x2ea043,
  LOCK: 0x1f4a8a,
  LOCK_PRESS: 0x2f6ac4,
  NEUTRAL: 0x2a2a2a,
  NEUTRAL_PRESS: 0x454545,
  ACCENT: 0x8a5a1f,
  ACCENT_PRESS: 0xc4832f
}

export const TITLE = {
  x: px(0), y: px(42), w: px(480), h: px(30),
  text_size: px(25)
}

// Sized to the worst message the app can produce, not the shortest: three
// wrapped lines at 22px. An overflowing status is what puts text on top of the
// buttons underneath.
export const STATUS = {
  x: px(64), y: px(76), w: px(352), h: px(112),
  text_size: px(22)
}

export const PRIMARY = {
  x: px(70), y: px(170), w: px(340), h: px(86),
  radius: px(43), text_size: px(33)
}

export const SECONDARY = {
  x: px(70), y: px(264), w: px(340), h: px(86),
  radius: px(43), text_size: px(33)
}

// Narrow and high enough to clear the bottom arc: at y+h the circle is only
// about 210px wide.
export const CONTROLS = {
  x: px(140), y: px(360), w: px(200), h: px(56),
  radius: px(28), text_size: px(23)
}

// The mark, at its natural 148:168 ratio after cropping.
//
// Large: anchors the screen before a car is paired, where there is nothing else
// to look at. Small: sits at the foot once the car is set up, below the
// controls and inside the bottom arc.
export const LOGO_LARGE = {
  x: px((480 - 148) / 2), y: px(212), w: px(148), h: px(168)
}

export const LOGO_SMALL = {
  x: px((480 - 40) / 2), y: px(426), w: px(40), h: px(45)
}
