// Exports the Freesla mark for use away from the watch.
//
//   npm run brand
//
// Writes freesla-gfx/export/. Nothing in the app reads any of it: these are for
// a README header, a store listing, a talk slide, a sticker.
//
// The mark is trademark artwork rather than code. See ATTRIBUTION.md before
// putting it on anything that is not this project.
//
// Two things this tool exists to get right.
//
// The first is the ceiling. The mark is supplied only as a 1500x1500 PNG whose
// ink occupies 873x993 of it, and there is no vector original, so 873px wide is
// every pixel of real detail that exists. Asking for more would be inventing
// detail and calling it resolution, so the largest export here is exactly the
// crop, untouched: not resampled at all, which is sharper than any resize of it
// could be. Everything smaller is area-averaged down from the full-size source
// rather than from an already-shrunk copy, so no export inherits another's
// losses.
//
// The second is backgrounds. A mark handed over as white-on-transparent and
// then dropped onto white by whatever tool opens it is a blank rectangle, so
// the versions meant for a slide or an avatar get their background baked in and
// say so in the filename.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodePng, alphaBounds, resampleArea, composite, encodePng } from './png.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'freesla-gfx/export')

const SOURCES = {
  // White for dark backgrounds, black for light ones. Both are supplied art;
  // neither is a recolour of the other.
  white: path.join(ROOT, 'freesla-gfx/logo-white.png'),
  black: path.join(ROOT, 'freesla-gfx/logo-black.png')
}

// Widths to write, largest first. The first entry is replaced by the source's
// own crop width at run time, so the set always tops out at native detail
// however the source art changes.
const WIDTHS = [null, 512, 256, 128]

// Square canvases, for the places that demand one: avatars, app listings, the
// corner of a slide. The mark is set to this share of the canvas height, which
// leaves it a margin of its own rather than running to the edges.
const SQUARE = 1024
const SQUARE_FILL = 0.6

const BACKDROPS = {
  dark: { ink: 'white', rgba: [0x0b, 0x0b, 0x0d, 0xff] },
  light: { ink: 'black', rgba: [0xff, 0xff, 0xff, 0xff] }
}

function write (name, image) {
  const png = encodePng(image)
  fs.writeFileSync(path.join(OUT, name), png)
  console.log('  ' + name.padEnd(36) + (image.width + 'x' + image.height).padEnd(12) +
    (png.length / 1024).toFixed(1) + ' KB')
  return png.length
}

// The source, decoded once and cropped to its ink. Every export below comes off
// this same original rather than off the previous size down.
function load (file) {
  const image = decodePng(fs.readFileSync(file))
  return { image, box: alphaBounds(image) }
}

// The crop at full size, copied out pixel for pixel.
//
// Not run through the resampler even though asking it for the crop's own width
// would be a no-op scale: a no-op that still rounds every channel through a
// weighted average is a no-op that can lose a value. Copying cannot.
function cropExact (source) {
  const { image, box } = source
  const out = Buffer.alloc(box.width * box.height * 4)
  for (let y = 0; y < box.height; y++) {
    const from = ((y + box.y) * image.width + box.x) * 4
    image.data.copy(out, y * box.width * 4, from, from + box.width * 4)
  }
  return { width: box.width, height: box.height, data: out }
}

function main () {
  fs.mkdirSync(OUT, { recursive: true })

  let total = 0
  let files = 0

  for (const ink of Object.keys(SOURCES)) {
    const file = SOURCES[ink]
    if (!fs.existsSync(file)) {
      console.log('  (skipped ' + ink + ': no source at ' + file + ')')
      continue
    }

    const source = load(file)
    console.log('')
    console.log(ink + ': ' + source.box.width + 'x' + source.box.height +
      ' of ink in a ' + source.image.width + 'px canvas')

    for (const width of WIDTHS) {
      const target = width === null ? source.box.width : width
      if (width !== null && target >= source.box.width) {
        console.log('  (skipped ' + target + ': the source has only ' +
          source.box.width + 'px to give)')
        continue
      }

      const image = width === null
        ? cropExact(source)
        : resampleArea(source.image, source.box, target,
          Math.round(target * (source.box.height / source.box.width)))

      total += write('freesla-' + ink + '-' + target + '.png', image)
      files++
    }
  }

  console.log('')
  for (const name of Object.keys(BACKDROPS)) {
    const backdrop = BACKDROPS[name]
    const file = SOURCES[backdrop.ink]
    if (!fs.existsSync(file)) continue

    const source = load(file)
    const height = Math.round(SQUARE * SQUARE_FILL)
    const width = Math.round(height * (source.box.width / source.box.height))
    const mark = resampleArea(source.image, source.box, width, height)

    const x = Math.round((SQUARE - width) / 2)
    const y = Math.round((SQUARE - height) / 2)

    // Named for what it is safe to put it on, since that is the only question
    // anybody asks of a logo file.
    total += write('freesla-square-on-' + name + '-' + SQUARE + '.png',
      composite(SQUARE, SQUARE, backdrop.rgba, mark, x, y))
    files++

    // The same square with nothing behind it, for anyone supplying their own
    // ground. Named for its ink instead, because that is what has to contrast.
    total += write('freesla-square-' + backdrop.ink + '-' + SQUARE + '.png',
      composite(SQUARE, SQUARE, [0, 0, 0, 0], mark, x, y))
    files++
  }

  console.log('')
  console.log(files + ' files, ' + (total / 1024).toFixed(1) + ' KB, in freesla-gfx/export/')
  console.log('Trademark artwork, not covered by the code licence. See ATTRIBUTION.md.')
}

main()
