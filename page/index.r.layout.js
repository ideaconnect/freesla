// Layout for the round 480px target. px() rescales for the 466px T-Rex 3 Pro,
// so both sizes share one definition.
//
// Two constraints drive every number here. A 480px circle only guarantees a
// 339px-wide inscribed square, so nothing wide may sit near the top or bottom
// edge. And the status line carries arbitrary vehicle messages, so its box is
// sized for three wrapped lines -- an overflowing status is what puts text on
// top of the buttons underneath.
//
// The screen has two faces, and they are laid out separately below:
//
//   Setup    -- one instruction and one button, while a car is being paired.
//               Wordy by necessity: every screen here has to say what to do
//               next, and several of them say it in three lines.
//   Driving   -- once the car is paired and in range. No instructions left to
//               give, so the words go and the controls get the room: Unlock in
//               the middle of the display where a thumb lands without aiming,
//               Lock and Controls either side of it.

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
  x: px(0), y: px(34), w: px(480), h: px(28),
  text_size: px(23)
}

// Sized to the worst message the app can produce, not the shortest: three
// wrapped lines at 20px. An overflowing status is what puts text on top of the
// buttons underneath.
export const STATUS = {
  x: px(64), y: px(68), w: px(352), h: px(84),
  text_size: px(20)
}

// --- Setup ---------------------------------------------------------------

export const PRIMARY = {
  x: px(70), y: px(162), w: px(340), h: px(84),
  radius: px(42), text_size: px(32)
}

// --- Driving -------------------------------------------------------------

// Unlock, in the middle of the display.
//
// Centred rather than stacked with the others because it is the one button
// pressed while walking, often without looking: the centre of a round watch is
// the only target that can be found by feel.
export const UNLOCK = {
  x: px(156), y: px(156), w: px(168), h: px(168)
}

// Flanking Unlock, and vertically centred on it. Their far edges sit 28px inside
// the bezel: centre 158px out from the middle, plus a 54px radius, against a
// 240px screen radius.
export const LOCK = {
  x: px(28), y: px(186), w: px(108), h: px(108)
}

export const CONTROLS = {
  x: px(344), y: px(186), w: px(108), h: px(108)
}

// One caption line under all three, on a shared baseline.
export const CAPTIONS = {
  y: px(332), h: px(26), text_size: px(20)
}

// What the car last said about itself: locked, or something standing open.
//
// Below the captions rather than up with the status, because the two answer
// different questions -- the status line says what this watch is doing, and this
// says what the car is. Blank until the car has actually said something; an
// empty line is honest, and a guess dressed as a reading is not.
// Sized for the longest thing it can say -- "Charge port open (unverified)" --
// on one line. This box does not wrap, so an underestimate here does not spill
// onto a second line, it silently loses the end of the sentence.
export const VEHICLE = {
  x: px(62), y: px(368), w: px(356), h: px(28),
  text_size: px(19)
}

// --- The mark ------------------------------------------------------------

// The mark, at its natural 96:109 ratio after cropping.
//
// Large: under the setup screen's button, filling the empty half of a screen
// that has one instruction and one thing to press. Under, and small enough to
// stay under: at its old size it was the biggest thing on the screen and sat
// across the button, so the button read as a green bar behind a logo rather
// than as the one control there.
//
// Small: sits at the foot once the car is set up, below the controls and inside
// the bottom arc.
export const LOGO_LARGE = {
  x: px((480 - 96) / 2), y: px(298), w: px(96), h: px(109)
}

export const LOGO_SMALL = {
  x: px((480 - 40) / 2), y: px(428), w: px(40), h: px(45)
}
