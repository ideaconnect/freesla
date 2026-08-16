// Generates the watch's button artwork from Font Awesome Free.
//
//   node tools/make-icons.js
//
// Zepp OS has no vector drawing and no icon font, so every control's artwork has
// to be a bitmap baked at build time. Each button is composed here as an SVG --
// a filled circle, the glyph, and for open/close pairs a small arrow badge so
// the two directions cannot be mistaken for each other at a glance -- and then
// rasterised.
//
// Two forms are written for each control: a complete button image, and the
// glyph alone on transparency, so the UI can either use image buttons or
// overlay an icon on a coloured button depending on what the runtime supports.
//
// Icons are Font Awesome Free 7.x, CC BY 4.0. See ATTRIBUTION.md.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

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
// script leaves them untouched when the source is missing. Point
// FREESLA_IDCT_LOGO at the SVG to regenerate them.
const IDCT_LOGO = process.env.FREESLA_IDCT_LOGO ||
  'C:/Users/ideac/Documents/IDCT/Branding/Logo/XLOGO.svg'
const IDCT_LOGO_WIDTH = 190

// The Freesla mark, supplied as light-on-transparent and dark-on-transparent.
// The watch uses the white one; the phone settings screen uses the black one.
const FREESLA_WHITE = path.join(ROOT, 'freesla-gfx/logo-white.png')
const FREESLA_BLACK = path.join(ROOT, 'freesla-gfx/logo-black.png')

const BUTTON_SIZE = 120
const GLYPH_SIZE = 52
const BADGE_SIZE = 26
const BADGE_RING = 19
// Kept close enough to the centre that the ring stays wholly inside the button
// circle: the offset is on the diagonal, so distance is offset * sqrt(2), and
// distance + BADGE_RING must stay under the button radius (60), with margin.
const BADGE_OFFSET = 23

// Colours match page/index.r.layout.js.
const COLOURS = {
  unlock: ['#1f7a3d', '#2ea043'],
  lock: ['#1f4a8a', '#2f6ac4'],
  neutral: ['#2a2a2a', '#454545'],
  caution: ['#8a5a1f', '#c4832f'],
  danger: ['#8a2320', '#c4342b']
}

// There is no doors-close: only a Model X can pull a door shut, and there the
// panel is a falcon wing whose obstruction sensing Tesla declines to promise.
// There is no frunk-close either, because no Tesla has one.
const CONTROLS = [
  { name: 'unlock', glyph: 'lock-open', colour: 'unlock' },
  { name: 'lock', glyph: 'lock', colour: 'lock' },
  { name: 'doors-open', glyph: 'door-open', colour: 'caution', badge: 'arrow-up' },
  { name: 'trunk-open', glyph: 'car-rear', colour: 'neutral', badge: 'arrow-up' },
  { name: 'trunk-close', glyph: 'car-rear', colour: 'caution', badge: 'arrow-down' },
  { name: 'frunk-open', glyph: 'car-side', colour: 'caution', badge: 'arrow-up' },
  { name: 'charge-port', glyph: 'bolt', colour: 'neutral' },
  { name: 'stop', glyph: 'hand', colour: 'danger' },
  { name: 'controls', glyph: 'sliders', colour: 'neutral' },
  { name: 'back', glyph: 'chevron-left', colour: 'neutral' },
  { name: 'about', glyph: 'circle-info', colour: 'neutral' },
  { name: 'github', glyph: 'github', set: 'brands', colour: 'neutral' }
]

// Finds the opaque bounds of an RGBA PNG.
//
// The Freesla mark is supplied on a 1500x1500 canvas with wide transparent
// margins. Scaling that whole canvas into a watch-sized box would shrink the
// visible mark to a fraction of the space it was given, so the padding is
// measured and cropped away instead of guessed at.
function pngAlphaBounds (buffer) {
  if (buffer.readUInt32BE(12) !== 0x49484452) throw new Error('not a PNG')

  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  const bitDepth = buffer[24]
  const colorType = buffer[25]
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error('expected 8-bit RGBA, got depth ' + bitDepth + ' type ' + colorType)
  }

  // Concatenate IDAT payloads, skipping the other chunks.
  const chunks = []
  let offset = 8
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') chunks.push(buffer.subarray(offset + 8, offset + 8 + length))
    if (type === 'IEND') break
    offset += length + 12
  }

  const raw = zlib.inflateSync(Buffer.concat(chunks))
  const bpp = 4
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)

  // Undo the per-scanline filters (PNG spec section 9).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    const up = dst - stride

    for (let x = 0; x < stride; x++) {
      const value = raw[src + x]
      const left = x >= bpp ? out[dst + x - bpp] : 0
      const above = y > 0 ? out[up + x] : 0
      const upperLeft = (y > 0 && x >= bpp) ? out[up + x - bpp] : 0

      let result
      if (filter === 0) result = value
      else if (filter === 1) result = value + left
      else if (filter === 2) result = value + above
      else if (filter === 3) result = value + ((left + above) >> 1)
      else {
        // Paeth
        const p = left + above - upperLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - above)
        const pc = Math.abs(p - upperLeft)
        const nearest = (pa <= pb && pa <= pc) ? left : (pb <= pc ? above : upperLeft)
        result = value + nearest
      }
      out[dst + x] = result & 0xff
    }
  }

  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Ignore near-transparent edge pixels so antialiasing does not inflate
      // the box by a pixel or two on every side.
      if (out[y * stride + x * bpp + 3] > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  if (maxX < 0) throw new Error('image is entirely transparent')
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

// Rasterises a PNG cropped to its opaque bounds, scaled to `width`.
function renderCroppedPng (file, width, out) {
  const source = fs.readFileSync(file)
  const box = pngAlphaBounds(source)
  const height = Math.round(width * (box.height / box.width))

  // The viewBox selects the opaque region, so the padding never reaches output.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height +
    '" viewBox="' + box.x + ' ' + box.y + ' ' + box.width + ' ' + box.height + '">' +
    '<image x="0" y="0" width="' + source.readUInt32BE(16) + '" height="' + source.readUInt32BE(20) +
    '" href="data:image/png;base64,' + source.toString('base64') + '"/></svg>'

  const png = new Resvg(svg, { background: 'rgba(0,0,0,0)' }).render().asPng()
  fs.writeFileSync(out, png)
  console.log('  ' + path.basename(out).padEnd(20) + width + 'x' + height +
    '  (cropped from ' + box.width + 'x' + box.height + ' of ' + source.readUInt32BE(16) + ')')
  return png.length
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

function readGlyph (name, set) {
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

  return { width: parts[2], height: parts[3], paths }
}

// Centres a glyph inside a box, preserving aspect ratio.
function placeGlyph (glyph, centreX, centreY, boxSize, fill) {
  const scale = boxSize / Math.max(glyph.width, glyph.height)
  const tx = centreX - (glyph.width * scale) / 2
  const ty = centreY - (glyph.height * scale) / 2
  const body = glyph.paths.map((d) => '<path d="' + d + '" fill="' + fill + '"/>').join('')
  return '<g transform="translate(' + tx.toFixed(2) + ',' + ty.toFixed(2) +
    ') scale(' + scale.toFixed(5) + ')">' + body + '</g>'
}

function buttonSvg (control, pressed) {
  const size = BUTTON_SIZE
  const centre = size / 2
  const fill = COLOURS[control.colour][pressed ? 1 : 0]

  let body = '<circle cx="' + centre + '" cy="' + centre + '" r="' + centre + '" fill="' + fill + '"/>'

  // Nudged up and left when a badge shares the circle, so the pair reads as
  // one centred mark rather than two things colliding.
  const glyphX = control.badge ? centre - 6 : centre
  const glyphY = control.badge ? centre - 9 : centre
  body += placeGlyph(readGlyph(control.glyph, control.set), glyphX, glyphY, GLYPH_SIZE, '#ffffff')

  if (control.badge) {
    const bx = centre + BADGE_OFFSET
    const by = centre + BADGE_OFFSET
    // A solid ring keeps the arrow legible where it overlaps the glyph.
    body += '<circle cx="' + bx + '" cy="' + by + '" r="' + BADGE_RING + '" fill="#ffffff"/>'
    body += placeGlyph(readGlyph(control.badge), bx, by, BADGE_SIZE, fill)
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

// Renders a single Font Awesome glyph to a data URI at a fixed colour and size.
function glyphDataUri (name, set, fill, size) {
  const glyph = readGlyph(name, set)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + glyph.width +
    '" height="' + glyph.height + '" viewBox="0 0 ' + glyph.width + ' ' + glyph.height + '">' +
    glyph.paths.map((d) => '<path d="' + d + '" fill="' + fill + '"/>').join('') + '</svg>'

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
    const source = fs.readFileSync(FREESLA_BLACK)
    const box = pngAlphaBounds(source)
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="' +
      Math.round(120 * (box.height / box.width)) + '" viewBox="' +
      box.x + ' ' + box.y + ' ' + box.width + ' ' + box.height + '">' +
      '<image x="0" y="0" width="' + source.readUInt32BE(16) + '" height="' +
      source.readUInt32BE(20) + '" href="data:image/png;base64,' +
      source.toString('base64') + '"/></svg>'
    const png = new Resvg(svg, { background: 'rgba(0,0,0,0)' }).render().asPng()
    images.freeslaLogo = 'data:image/png;base64,' + png.toString('base64')
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

  // Two sizes: one to anchor the unconfigured screen, one to sit quietly at the
  // foot of the main screen once the car is paired.
  total += renderCroppedPng(FREESLA_WHITE, 148, path.join(OUT_BRAND, 'freesla.png'))
  total += renderCroppedPng(FREESLA_WHITE, 40, path.join(OUT_BRAND, 'freesla-small.png'))

  total += writeSettingsAssets()
  for (const control of CONTROLS) {
    total += render(buttonSvg(control, false), path.join(OUT_BUTTONS, control.name + '_n.png'))
    total += render(buttonSvg(control, true), path.join(OUT_BUTTONS, control.name + '_p.png'))
    total += render(glyphSvg(control), path.join(OUT_GLYPHS, control.name + '.png'))
    console.log('  ' + control.name.padEnd(14) + control.glyph +
      (control.badge ? ' + ' + control.badge : ''))
  }

  console.log('')
  console.log(CONTROLS.length + ' controls, ' + (CONTROLS.length * 3) + ' images, ' +
    (total / 1024).toFixed(1) + ' KB total')
}

main()
