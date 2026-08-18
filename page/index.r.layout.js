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
  ACCENT_PRESS: 0xc4832f,
  // Stop is the only control that interrupts rather than commands, and the only
  // one drawn as a bar. Matches the `danger` fill in tools/make-icons.js.
  DANGER: 0x8a2320,
  DANGER_PRESS: 0xc4342b
}

export const TITLE = {
  x: px(0), y: px(32), w: px(480), h: px(30),
  text_size: px(25)
}

// Sized to the worst message the app can produce, not the shortest: three
// wrapped lines at 21px, which is what the longest of them needs. An
// overflowing status is what puts text on top of the buttons underneath, so
// the box grows with the type rather than the type being kept small to fit a
// box.
export const STATUS = {
  x: px(62), y: px(66), w: px(356), h: px(88),
  text_size: px(21)
}

// --- Setup ---------------------------------------------------------------

export const PRIMARY = {
  x: px(70), y: px(162), w: px(340), h: px(84),
  radius: px(42), text_size: px(32)
}

// --- Driving -------------------------------------------------------------

// What the car last said about itself, in one line.
//
// Sized for the longest thing it can say, "Charge port open (unverified)". This
// box does not wrap, so an underestimate does not spill onto a second line, it
// silently loses the end of the sentence.
export const VEHICLE = {
  x: px(56), y: px(158), w: px(368), h: px(30),
  text_size: px(21)
}

// The driving face is one scrolling column, so its geometry is walked down
// rather than written out: the page builds it top to bottom from these sizes
// and keeps a running y. Fixed coordinates for a list this long are a set of
// numbers that have to be re-derived by hand every time a row moves.
//
// The only position here is where the column starts. Everything else is a size
// and a gap.
export const DRIVE = {
  top: px(200),

  // Everything in the column is centred, so the horizontals live here too
  // rather than being recomputed from a width the page would have to know.
  heroX: px((480 - 168) / 2),
  buttonX: px((480 - 120) / 2),
  textX: px(56),
  textW: px(368),

  // Lock and Unlock are one button, and it is the biggest thing on the screen.
  // It sits where a thumb lands without aiming, because it is the one control
  // pressed while walking towards a car rather than standing at it.
  hero: px(168),
  heroCaption: { h: px(32), text_size: px(24) },

  // Each closure below is a heading, a button, and what the car says that panel
  // is. The heading is what makes the button legible without a caption crowded
  // under it: "Trunk" over an open-boot icon needs no further sentence.
  header: { h: px(34), text_size: px(26) },
  button: px(120),
  caption: { h: px(30), text_size: px(20) },

  // Stop is wide and flat where everything else is a circle, so a hand reaching
  // for it in a hurry cannot land on anything else by mistake.
  stop: { x: px(90), w: px(300), h: px(78), radius: px(39), text_size: px(30) },

  gap: px(8),
  sectionGap: px(30),
  footerGap: px(44)
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

// Follows the foot of whichever column it is under, so only its size and its
// centring are fixed. The driving face is a scrolling list whose length depends
// on how many controls the car has, and a fixed y would either float in the
// middle of it or fall off the end.
export const LOGO_SMALL = {
  x: px((480 - 40) / 2), y: px(428), w: px(40), h: px(45)
}
