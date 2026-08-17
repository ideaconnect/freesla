// Hand-drawn vehicle glyphs, for the pictures no icon set has.
//
// Font Awesome Free has no boot, no frunk, and no car with a panel standing
// open. What it does have is `car-side` and `car-rear`, and the first version of
// this app used one of each with a small arrow badge to tell them apart. Side by
// side on the controls list they were two pictures of a car: the difference
// between "open the boot" and "open the frunk" lived entirely in a 26px arrow
// pointing the same direction on both.
//
// Free sets that do have a dedicated boot icon exist -- Atlas Icons is MIT and
// has one -- but they are thin line art, and this app's other artwork is Font
// Awesome's solid style. A single line icon among ten solid ones reads as a
// mistake, and at the size these are drawn on a watch a 2px stroke is most of a
// pixel once it has been through the scaler.
//
// So the vehicle glyphs are drawn here instead: one car in profile, facing
// right, with the panel that a given control moves actually shown moving, and
// the compartment it opens shown open. Boot and frunk lift away from each other,
// which is the whole point -- left or right is a difference readable at a glance
// where two arrows pointing the same way were not.
//
// Everything is composed from primitives in a 512-wide design space, and each
// glyph reports its own bounds so the renderer can crop to the ink. Nothing here
// is traced from anyone else's artwork.

// One car, shared by every glyph below, so a column of them sits at one height
// with its wheels on one line.
const REAR_X = 30
const NOSE_X = 484
const DECK_TOP = 298
const SILL_Y = 380
// How far the body's top edge drops over a compartment standing open. The lid
// above it says which panel moved; this says the car is open.
const OPEN_TOP = 340
const AXLE_Y = 380
const WHEEL_R = 40
const REAR_AXLE_X = 152
const FRONT_AXLE_X = 368
// Wider than the tyre, so daylight shows between the two and a wheel reads as a
// wheel rather than as a bulge in the bodywork.
const ARCH_R = 58

// Where the boot lid and the bonnet are hinged: at the foot of the rear pillar
// and at the foot of the windscreen, which is where a car hinges them.
const BOOT_HINGE = [146, 304]
const BONNET_HINGE = [386, 304]

// Collects shapes and the box they fill.
//
// The bounds matter as much as the markup: these glyphs are cropped to their ink
// before being scaled into a button, so a box guessed a little too large shrinks
// the car and a box guessed a little too small clips a wheel. Measuring as we go
// means the two cannot disagree.
function drawing () {
  const parts = []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  function grow (x, y) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }

  function n (value) {
    return Math.round(value * 100) / 100
  }

  return {
    circle (cx, cy, r) {
      parts.push('<circle cx="' + n(cx) + '" cy="' + n(cy) + '" r="' + n(r) + '"/>')
      grow(cx - r, cy - r)
      grow(cx + r, cy + r)
      return this
    },

    // Straight-edged polygon from a list of [x, y] pairs.
    poly (points) {
      parts.push('<polygon points="' +
        points.map((p) => n(p[0]) + ',' + n(p[1])).join(' ') + '"/>')
      for (const p of points) grow(p[0], p[1])
      return this
    },

    // A path whose bounds are taken from the points that define it. Safe for the
    // rounded corners and wheel arches used below: neither a quadratic curve nor
    // a circular arc ever leaves the hull of the points it is drawn between, so
    // this can only be generous, never tight.
    path (d, points) {
      parts.push('<path d="' + d + '"/>')
      for (const p of points) grow(p[0], p[1])
      return this
    },

    done () {
      return {
        // A hair of padding, so antialiasing at the extremes is not shaved off
        // by the crop.
        box: [minX - 4, minY - 4, (maxX - minX) + 8, (maxY - minY) + 8],
        body: parts.join('')
      }
    }
  }
}

// A flat panel hinged at one point and swung out along a direction: a boot lid,
// a bonnet, a door. Drawn as a plain quadrilateral rather than anything tapered,
// because at watch size a taper reads as a wobble.
function panel (d, hinge, direction, length, thickness) {
  const scale = Math.sqrt(direction[0] * direction[0] + direction[1] * direction[1])
  const ux = direction[0] / scale
  const uy = direction[1] / scale
  // Half the thickness, at right angles to the swing.
  const px = -uy * (thickness / 2)
  const py = ux * (thickness / 2)

  const near1 = [hinge[0] + px, hinge[1] + py]
  const near2 = [hinge[0] - px, hinge[1] - py]
  const far1 = [near1[0] + ux * length, near1[1] + uy * length]
  const far2 = [near2[0] + ux * length, near2[1] + uy * length]

  return d.poly([near1, far1, far2, near2])
}

function wheels (d) {
  return d
    .circle(REAR_AXLE_X, AXLE_Y, WHEEL_R)
    .circle(FRONT_AXLE_X, AXLE_Y, WHEEL_R)
}

// The bodywork below the windows, traced clockwise from its rear top corner.
//
// `open` drops the top edge over one compartment -- 'rear' for the boot,
// 'front' for the frunk -- so the car is visibly hollow where the lid came off,
// and the lid alone is not carrying the whole message.
function deck (d, open) {
  // Bottom edge, right to left, arching over each wheel. Drawn as two semi-
  // circles: the arch is wider than the tyre, so the gap between them is what
  // makes the wheels legible.
  const underside =
    ' L ' + (FRONT_AXLE_X + ARCH_R) + ' ' + SILL_Y +
    ' A ' + ARCH_R + ' ' + ARCH_R + ' 0 0 0 ' + (FRONT_AXLE_X - ARCH_R) + ' ' + SILL_Y +
    ' L ' + (REAR_AXLE_X + ARCH_R) + ' ' + SILL_Y +
    ' A ' + ARCH_R + ' ' + ARCH_R + ' 0 0 0 ' + (REAR_AXLE_X - ARCH_R) + ' ' + SILL_Y +
    ' L 48 ' + SILL_Y + ' Q ' + REAR_X + ' ' + SILL_Y + ' ' + REAR_X + ' 362'

  let d1
  if (open === 'rear') {
    // Starts on the lip of the open boot rather than at a rounded corner: an
    // opening should look cut, not moulded.
    d1 = 'M ' + REAR_X + ' ' + OPEN_TOP +
      ' L ' + BOOT_HINGE[0] + ' ' + OPEN_TOP +
      ' L ' + BOOT_HINGE[0] + ' ' + DECK_TOP +
      ' L 466 ' + DECK_TOP + ' Q ' + NOSE_X + ' ' + DECK_TOP + ' ' + NOSE_X + ' 316' +
      ' L ' + NOSE_X + ' 362 Q ' + NOSE_X + ' ' + SILL_Y + ' 466 ' + SILL_Y +
      underside + ' Z'
  } else if (open === 'front') {
    d1 = 'M 48 ' + DECK_TOP + ' L ' + BONNET_HINGE[0] + ' ' + DECK_TOP +
      ' L ' + BONNET_HINGE[0] + ' ' + OPEN_TOP +
      ' L ' + NOSE_X + ' ' + OPEN_TOP +
      ' L ' + NOSE_X + ' 362 Q ' + NOSE_X + ' ' + SILL_Y + ' 466 ' + SILL_Y +
      underside + ' L ' + REAR_X + ' 316 Q ' + REAR_X + ' ' + DECK_TOP + ' 48 ' + DECK_TOP + ' Z'
  } else {
    d1 = 'M 48 ' + DECK_TOP + ' L 466 ' + DECK_TOP +
      ' Q ' + NOSE_X + ' ' + DECK_TOP + ' ' + NOSE_X + ' 316' +
      ' L ' + NOSE_X + ' 362 Q ' + NOSE_X + ' ' + SILL_Y + ' 466 ' + SILL_Y +
      underside + ' L ' + REAR_X + ' 316 Q ' + REAR_X + ' ' + DECK_TOP + ' 48 ' + DECK_TOP + ' Z'
  }

  return d.path(d1, [[REAR_X, DECK_TOP], [NOSE_X, DECK_TOP], [NOSE_X, SILL_Y], [REAR_X, SILL_Y]])
}

// The greenhouse: rear pillar, roof, windscreen.
function cabin (d) {
  return d.path(
    'M 156 ' + DECK_TOP + ' L 202 214 Q 212 196 234 196 L 306 196 Q 330 196 340 214' +
    ' L 388 ' + DECK_TOP + ' Z',
    [[156, DECK_TOP], [202, 196], [340, 196], [388, DECK_TOP]])
}

// Boot open: lid up and back off its hinge, boot floor exposed behind the cabin.
function trunkOpen () {
  const d = drawing()
  deck(d, 'rear')
  cabin(d)
  panel(d, BOOT_HINGE, [-0.66, -0.75], 138, 34)
  wheels(d)
  return d.done()
}

// Boot closing: the same lid on the same hinge, all but shut.
//
// Nearly flat against nearly upright is a difference visible across a room,
// which is the point -- these two sit one above the other on the controls list,
// and the arrow badge should be confirming what the picture already said rather
// than being the only thing that says it.
function trunkClosing () {
  const d = drawing()
  deck(d, 'rear')
  cabin(d)
  panel(d, BOOT_HINGE, [-0.97, -0.25], 108, 32)
  wheels(d)
  return d.done()
}

// Frunk open: bonnet up and forward, front compartment exposed ahead of the
// windscreen. Hinged where a Tesla hinges it, which is also the arrangement that
// cannot be confused with the boot: the two lids lean away from each other.
function frunkOpen () {
  const d = drawing()
  deck(d, 'front')
  cabin(d)
  panel(d, BONNET_HINGE, [0.66, -0.75], 130, 34)
  wheels(d)
  return d.done()
}

// A closed car, for anything about the whole vehicle rather than one panel.
function carClosed () {
  const d = drawing()
  deck(d)
  cabin(d)
  wheels(d)
  return d.done()
}

// No door here, and it is not for want of trying. A profile car cannot show a
// door swinging towards the viewer, and every version of it -- hanging past the
// sill, swung forward over the wheel -- came out looking like a kickstand. Drawn
// from above instead, the car stops being a car: two rounded blocks and two
// wings read as a scarecrow. So the doors row keeps Font Awesome's `door-open`,
// which is at least unmistakably a door standing open.
export const VEHICLE_GLYPHS = {
  'car-trunk-open': trunkOpen(),
  'car-trunk-closing': trunkClosing(),
  'car-frunk-open': frunkOpen(),
  'car-closed': carClosed()
}
