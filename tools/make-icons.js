// Generates the watch's button artwork.
//
//   node tools/make-icons.js
//
// Zepp OS has no vector drawing and no icon font, so every control's artwork has
// to be a bitmap baked at build time. Each button is composed here as an SVG --
// a filled circle, a rim so it separates from the black background, the glyph,
// and for open/close pairs a small arrow badge -- and then rasterised.
//
// Two forms are written for each control: a complete button image, and the
// glyph alone on transparency, so the UI can either use image buttons or
// overlay an icon on a coloured button depending on what the runtime supports.
// Buttons come in three sizes, because the screens want different weights from
// the same control: a hero Unlock, a companion Lock, a list row.
//
// Interface icons are Font Awesome Free 7.x, CC BY 4.0. The vehicle glyphs --
// boot, frunk, doors, charge port -- are drawn in tools/glyphs.js, since no free
// set has them. See ATTRIBUTION.md.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { VEHICLE_GLYPHS } from './glyphs.js'
import { scaleCropped, encodePng } from './png.js'

// Loaded through a computed specifier on purpose. The Zepp bundler walks every
// JS file in the project, and a static import here makes it try to parse
// resvg's native binary as JavaScript, which fails the whole app build. This
// tool only ever runs under Node, so resolving it late costs nothing.
const require = createRequire(import.meta.url)
const RESVG_MODULE = '@resvg/' + 'resvg-js'
const { Resvg } = require(RESVG_MODULE)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FA = path.join(ROOT, 'node_modules/@fortawesome/fontawesome-free/svgs')
const OUT_BUTTONS = path.join(ROOT, 'assets/default.r/btn')
const OUT_GLYPHS = path.join(ROOT, 'assets/default.r/icons')
const OUT_BRAND = path.join(ROOT, 'assets/default.r/brand')

// The IDCT mark is drawn in near-black for print and light backgrounds. The
// watch UI is dark, so it is recoloured white on the way in rather than kept as
// a second asset that could drift out of step.
//
// The brand source lives outside the repository, so anyone else who runs this
// will not have it. That is fine: the rendered marks are committed, and this
// script leaves them untouched when the source is missing. To regenerate them:
//
//   FREESLA_IDCT_LOGO=/path/to/XLOGO.svg node tools/make-icons.js
const IDCT_LOGO = process.env.FREESLA_IDCT_LOGO || ''
const IDCT_LOGO_WIDTH = 190

// The Freesla mark, supplied as light-on-transparent and dark-on-transparent.
// The watch uses the white one; the phone settings screen uses the black one.
const FREESLA_WHITE = path.join(ROOT, 'freesla-gfx/logo-white.png')
const FREESLA_BLACK = path.join(ROOT, 'freesla-gfx/logo-black.png')

// The button sizes the screens ask for. `md` is the controls list's row icon and
// the name a control is written out under when nothing else is said; `lg` is the
// main screen's Unlock, which is the one button anybody presses walking to a
// car; `sm` is everything that keeps it company.
const SIZES = { sm: 108, md: 120, lg: 168 }
const GLYPH_SIZE = 58
const GLYPH_RATIO = GLYPH_SIZE / 120
// How much bigger a wide glyph is allowed to be drawn.
//
// Glyphs are fitted by their longest side, which suits the square ones and
// starves the cars: a car is twice as wide as it is tall, so fitting its width
// to the same box leaves it half the height of a padlock and reading as a much
// smaller mark. The circle has the room, so the cars take it.
const WIDE_ZOOM = 1.3
const BADGE_SIZE = 24
const BADGE_RING = 17
// Kept close enough to the centre that the ring stays wholly inside the button
// circle: the offset is on the diagonal, so distance is offset * sqrt(2), and
// distance + the badge's outer disc must stay under the button radius (60).
const BADGE_OFFSET = 25
// A rim, one shade up from the fill. Without it a neutral button is #2a2a2a on
// black, which on an OLED panel in daylight is a button you have to hunt for.
const RIM_WIDTH = 3

// Colours match page/index.r.layout.js: fill, pressed fill, rim.
const COLOURS = {
  unlock: ['#1f7a3d', '#2ea043', '#43c46d'],
  lock: ['#1f4a8a', '#2f6ac4', '#4f8ae0'],
  neutral: ['#2a2a2a', '#454545', '#5a5a5a'],
  caution: ['#8a5a1f', '#c4832f', '#d9a04f'],
  danger: ['#8a2320', '#c4342b', '#e05a50']
}

// There is no doors-close: only a Model X can pull a door shut, and there the
// panel is a falcon wing whose obstruction sensing Tesla declines to promise.
// There is no frunk-close either, because no Tesla has one.
//
// Colour carries one meaning: amber is a move the car cannot undo from here.
// Opening the boot or the charge port is reversible from the same screen, so
// both stay neutral. Raising the bonnet is not, unlatching the doors is not,
// and driving a powered liftgate downwards is the direction that can shut on
// something. Red is not a warning but an interruption: the control you reach
// for when a panel is already moving and should not be.
//
// `set: 'vehicle'` means the glyph is drawn in tools/glyphs.js rather than taken
// from Font Awesome. Every control that moves a panel of the car is one of
// those, so the picture shows which panel and which way it is going.
const CONTROLS = [
  { name: 'unlock', glyph: 'lock-open', colour: 'unlock', sizes: ['md', 'lg'] },
  { name: 'lock', glyph: 'lock', colour: 'lock', sizes: ['sm', 'md', 'lg'] },
  { name: 'doors-open', glyph: 'door-open', colour: 'caution', badge: 'arrow-up' },
  { name: 'trunk-open', glyph: 'car-trunk-open', set: 'vehicle', colour: 'neutral', badge: 'arrow-up' },
  { name: 'trunk-close', glyph: 'car-trunk-closing', set: 'vehicle', colour: 'caution', badge: 'arrow-down' },
  { name: 'frunk-open', glyph: 'car-frunk-open', set: 'vehicle', colour: 'caution', badge: 'arrow-up' },
  { name: 'charge-port', glyph: 'bolt', colour: 'neutral', badge: 'arrow-up' },
  { name: 'charge-port-close', glyph: 'bolt', colour: 'neutral', badge: 'arrow-down' },
  { name: 'stop', glyph: 'hand', colour: 'danger' },
  { name: 'controls', glyph: 'sliders', colour: 'neutral', sizes: ['sm', 'md'] },
  { name: 'back', glyph: 'chevron-left', colour: 'neutral', sizes: ['sm', 'md'] },
  { name: 'about', glyph: 'circle-info', colour: 'neutral' },
  { name: 'github', glyph: 'github', set: 'brands', colour: 'neutral' }
]

// `md` keeps the bare name, so the files the controls list already asks for do
// not move every time another size is added.
function buttonFile (name, size) {
  return size === 'md' ? name : name + '-' + size
}

// Crops a PNG to its opaque bounds and resamples it to `width`. The pixel
// work lives in tools/png.js, which tools/make-brand.js shares.
function scaleCroppedPng (file, width) {
  const scaled = scaleCropped(file, width, fs.readFileSync)
  return { png: encodePng(scaled.image), box: scaled.box, height: scaled.image.height }
}

function renderCroppedPng (file, width, out) {
  const scaled = scaleCroppedPng(file, width)
  fs.writeFileSync(out, scaled.png)
  console.log('  ' + path.basename(out).padEnd(20) + width + 'x' + scaled.height +
    '  (area-averaged from ' + scaled.box.width + 'x' + scaled.box.height + ')')
  return scaled.png.length
}

// Recolours a single-colour SVG and rasterises it. Used for the IDCT mark,
// which ships in near-black and would be invisible on the watch.
function renderLogo (file, width, fill, out) {
  if (!fs.existsSync(file)) {
    console.log('  (skipped logo: not found at ' + file + ')')
    return 0
  }

  let svg = fs.readFileSync(file, 'utf8')

  // Only some of the paths carry an explicit fill; the rest rely on SVG's black
  // default. Recolouring just the explicit ones repaints half the artwork and
  // leaves the other half black, so every fill is stripped and the colour is
  // set once on the root for all of them to inherit.
  svg = svg.replace(/\sfill="[^"]*"/g, '')
  svg = svg.replace('<svg', '<svg fill="' + fill + '"')

  const viewBox = /viewBox="([\d.\s-]+)"/.exec(svg)
  const parts = viewBox ? viewBox[1].trim().split(/\s+/).map(Number) : [0, 0, width, width]
  const height = Math.round(width * (parts[3] / parts[2]))

  const png = new Resvg(svg, {
    background: 'rgba(0,0,0,0)',
    fitTo: { mode: 'width', value: width }
  }).render().asPng()
  fs.writeFileSync(out, png)
  console.log('  ' + path.basename(out).padEnd(14) + width + 'x' + height + ' (' + fill + ')')
  return png.length
}

// A glyph, as a box of markup: where its ink starts, how big it is, and what
// draws it. Font Awesome's icons and the hand-drawn vehicles both reduce to
// this, so everything downstream can stop caring which is which.
function readGlyph (name, set) {
  if (set === 'vehicle') {
    const drawn = VEHICLE_GLYPHS[name]
    if (!drawn) throw new Error('no such vehicle glyph: ' + name)
    return {
      x: drawn.box[0],
      y: drawn.box[1],
      width: drawn.box[2],
      height: drawn.box[3],
      body: drawn.body
    }
  }

  const file = path.join(FA, set || 'solid', name + '.svg')
  if (!fs.existsSync(file)) throw new Error('no such Font Awesome icon: ' + name)

  const svg = fs.readFileSync(file, 'utf8')
  const viewBox = /viewBox="([\d.\s-]+)"/.exec(svg)
  if (!viewBox) throw new Error('no viewBox in ' + name)

  const parts = viewBox[1].trim().split(/\s+/).map(Number)
  const paths = []
  const re = /<path[^>]*\sd="([^"]+)"/g
  let match
  while ((match = re.exec(svg)) !== null) paths.push(match[1])
  if (paths.length === 0) throw new Error('no path data in ' + name)

  // The fill is dropped rather than kept: Font Awesome ships `currentColor`,
  // which resolves to black outside a document that sets one, and a black glyph
  // on a dark button is an empty circle. Colour is applied on the group below,
  // for every shape at once.
  return {
    x: parts[0],
    y: parts[1],
    width: parts[2],
    height: parts[3],
    body: paths.map((d) => '<path d="' + d + '"/>').join('')
  }
}

// Centres a glyph inside a box, preserving aspect ratio.
function placeGlyph (glyph, centreX, centreY, boxSize, fill) {
  const scale = boxSize / Math.max(glyph.width, glyph.height)
  const tx = centreX - (glyph.width * scale) / 2 - glyph.x * scale
  const ty = centreY - (glyph.height * scale) / 2 - glyph.y * scale
  return '<g fill="' + fill + '" transform="translate(' + tx.toFixed(2) + ',' + ty.toFixed(2) +
    ') scale(' + scale.toFixed(5) + ')">' + glyph.body + '</g>'
}

function buttonSvg (control, size, pressed) {
  const centre = size / 2
  const palette = COLOURS[control.colour]
  const fill = palette[pressed ? 1 : 0]
  const scale = size / SIZES.md
  const glyph = readGlyph(control.glyph, control.set)
  const wide = glyph.width > glyph.height * 1.5
  const glyphSize = size * GLYPH_RATIO * (wide ? WIDE_ZOOM : 1)
  const rim = RIM_WIDTH * scale

  // Inset by half the stroke, or the rim is drawn half outside the circle and
  // the scaler eats the half that is left.
  let body = '<circle cx="' + centre + '" cy="' + centre + '" r="' + (centre - rim / 2) +
    '" fill="' + fill + '" stroke="' + palette[2] + '" stroke-width="' + rim.toFixed(2) + '"/>'

  // Nudged up and left when a badge shares the circle, so the pair reads as
  // one centred mark rather than two things colliding.
  const glyphX = control.badge ? centre - 8 * scale : centre
  const glyphY = control.badge ? centre - 12 * scale : centre
  body += placeGlyph(glyph, glyphX, glyphY, glyphSize, '#ffffff')

  if (control.badge) {
    const bx = centre + BADGE_OFFSET * scale
    const by = centre + BADGE_OFFSET * scale
    // Three discs, not one. The badge sits over the glyph, and white on white
    // would weld the two together -- a car with a bite taken out of its front
    // wheel. The outer disc is the button's own colour, so the badge always has
    // a moat around it whatever it lands on.
    body += '<circle cx="' + bx + '" cy="' + by + '" r="' + ((BADGE_RING + 4) * scale) +
      '" fill="' + fill + '"/>'
    body += '<circle cx="' + bx + '" cy="' + by + '" r="' + (BADGE_RING * scale) +
      '" fill="#ffffff"/>'
    body += placeGlyph(readGlyph(control.badge), bx, by, BADGE_SIZE * scale, fill)
  }

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
    '" viewBox="0 0 ' + size + ' ' + size + '">' + body + '</svg>'
}

function glyphSvg (control) {
  const size = GLYPH_SIZE + 8
  const body = placeGlyph(readGlyph(control.glyph, control.set), size / 2, size / 2, GLYPH_SIZE, '#ffffff')
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
    '" viewBox="0 0 ' + size + ' ' + size + '">' + body + '</svg>'
}

function render (svg, file) {
  const png = new Resvg(svg, { background: 'rgba(0,0,0,0)' }).render().asPng()
  fs.writeFileSync(file, png)
  return png.length
}

// Reads the data URIs already committed in setting/assets.js, so a run on a
// machine lacking the brand sources can preserve rather than erase them.
function readExistingAssets () {
  const file = path.join(ROOT, 'setting/assets.js')
  if (!fs.existsSync(file)) return {}

  const found = {}
  const source = fs.readFileSync(file, 'utf8')
  const re = /export const (\w+) = '([^']*)'/g
  let match
  while ((match = re.exec(source)) !== null) found[match[1]] = match[2]
  return found
}

// Renders a single glyph to a data URI at a fixed colour and size.
function glyphDataUri (name, set, fill, size) {
  const glyph = readGlyph(name, set)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + glyph.width +
    '" height="' + glyph.height + '" viewBox="' + glyph.x + ' ' + glyph.y + ' ' +
    glyph.width + ' ' + glyph.height + '" fill="' + fill + '">' + glyph.body + '</svg>'

  const png = new Resvg(svg, {
    background: 'rgba(0,0,0,0)',
    fitTo: { mode: 'width', value: size }
  }).render().asPng()
  return 'data:image/png;base64,' + png.toString('base64')
}

// The settings screen runs on the phone, where there is no asset pipeline to
// load a file from -- so its artwork is emitted as a module of data URIs that
// the page can inline directly.
function writeSettingsAssets () {
  // Every key is always emitted, even when its source art is unavailable.
  // Dropping one would remove a named export that setting/index.js imports,
  // which fails at module load and blanks the whole settings screen -- a far
  // worse outcome than a missing picture. The page already guards each image.
  const images = { idctLogo: '', freeslaLogo: '' }
  const existing = readExistingAssets()

  if (fs.existsSync(IDCT_LOGO)) {
    let svg = fs.readFileSync(IDCT_LOGO, 'utf8')
    svg = svg.replace(/\sfill="[^"]*"/g, '').replace('<svg', '<svg fill="#1a1a1a"')
    const png = new Resvg(svg, {
      background: 'rgba(0,0,0,0)',
      fitTo: { mode: 'width', value: 132 }
    }).render().asPng()
    images.idctLogo = 'data:image/png;base64,' + png.toString('base64')
  }

  if (fs.existsSync(FREESLA_BLACK)) {
    // Through the same resampler as the watch's copy. The settings screen is
    // the one place this mark is seen on a phone, at a pixel density that shows
    // a ragged diagonal more clearly than the watch ever could.
    const scaled = scaleCroppedPng(FREESLA_BLACK, 120)
    images.freeslaLogo = 'data:image/png;base64,' + scaled.png.toString('base64')
  }

  // Font Awesome has no Buy Me a Coffee brand mark, so the solid mug stands in.
  images.githubMark = glyphDataUri('github', 'brands', '#24292f', 40)
  images.coffeeMark = glyphDataUri('mug-hot', 'solid', '#292929', 44)

  // Keep whatever was generated on a machine that did have the source art, so
  // running this without it does not silently blank the committed marks.
  for (const key of Object.keys(images)) {
    if (!images[key] && existing[key]) {
      images[key] = existing[key]
      console.log('  (kept existing ' + key + ': source art not available here)')
    }
  }

  const body = '// Generated by tools/make-icons.js -- do not edit by hand.\n' +
    '//\n' +
    '// The settings page has no asset pipeline, so its images are inlined as\n' +
    '// data URIs. Regenerate with: node tools/make-icons.js\n\n' +
    Object.keys(images).map((key) =>
      'export const ' + key + ' = \'' + images[key] + '\'\n').join('\n')

  fs.writeFileSync(path.join(ROOT, 'setting/assets.js'), body)
  const bytes = Buffer.byteLength(body)
  console.log('  setting/assets.js  ' + Object.keys(images).join(', ') +
    '  (' + (bytes / 1024).toFixed(1) + ' KB)')
  return bytes
}

function main () {
  fs.mkdirSync(OUT_BUTTONS, { recursive: true })
  fs.mkdirSync(OUT_GLYPHS, { recursive: true })
  fs.mkdirSync(OUT_BRAND, { recursive: true })

  let total = 0
  total += renderLogo(IDCT_LOGO, IDCT_LOGO_WIDTH, '#ffffff', path.join(OUT_BRAND, 'idct.png'))

  // Two sizes: one under the unconfigured screen's button, one to sit quietly
  // at the foot of the main screen once the car is paired. Rendered at the size
  // they are drawn, because widget.IMG paints a bitmap at its own size and
  // treats w and h as the box it is painted into, not as a scale.
  total += renderCroppedPng(FREESLA_WHITE, 96, path.join(OUT_BRAND, 'freesla.png'))
  total += renderCroppedPng(FREESLA_WHITE, 40, path.join(OUT_BRAND, 'freesla-small.png'))

  total += writeSettingsAssets()
  let images = 0
  for (const control of CONTROLS) {
    for (const size of control.sizes || ['md']) {
      const file = buttonFile(control.name, size)
      total += render(buttonSvg(control, SIZES[size], false), path.join(OUT_BUTTONS, file + '_n.png'))
      total += render(buttonSvg(control, SIZES[size], true), path.join(OUT_BUTTONS, file + '_p.png'))
      images += 2
    }
    total += render(glyphSvg(control), path.join(OUT_GLYPHS, control.name + '.png'))
    images++
    console.log('  ' + control.name.padEnd(14) +
      (control.set === 'vehicle' ? 'drawn ' : '') + control.glyph +
      (control.badge ? ' + ' + control.badge : ''))
  }

  console.log('')
  console.log(CONTROLS.length + ' controls, ' + images + ' images, ' +
    (total / 1024).toFixed(1) + ' KB total')
}

main()
