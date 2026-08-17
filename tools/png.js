// Just enough PNG to shrink a picture properly.
//
// Hand-rolled rather than pulled in, because the only thing here that reads
// pixels is the brand mark and the alternative is a dependency in the build
// path of an app whose whole point is that you can audit what it does. Node
// brings the hard part -- zlib -- already.
//
// The reason any of this exists is the resampler below. Handing the mark to an
// SVG rasteriser to squeeze into a watch-sized box looked reasonable and was
// not: at nine source pixels to one output pixel it samples rather than
// averages, and every diagonal on the mark came out a bare staircase.

import zlib from 'node:zlib'

// Decodes an 8-bit RGBA PNG to raw pixels.
export function decodePng (buffer) {
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

  return { width, height, data: out }
}

// Finds the opaque bounds of a decoded image.
//
// The Freesla mark is supplied on a 1500x1500 canvas with wide transparent
// margins. Scaling that whole canvas into a box would shrink the visible mark
// to a fraction of the space it was given, so the padding is measured and
// cropped away instead of guessed at.
export function alphaBounds (image) {
  let minX = image.width
  let minY = image.height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      // Ignore near-transparent edge pixels so antialiasing does not inflate
      // the box by a pixel or two on every side.
      if (image.data[(y * image.width + x) * 4 + 3] > 8) {
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

// Shrinks a region of an image by averaging every source pixel that falls under
// each output pixel.
//
// Two details make it correct rather than merely blurry. Edge pixels count for
// the fraction of themselves that actually falls inside the output pixel, so a
// scale factor that is not a whole number does not shift the image around. And
// colour is averaged premultiplied by alpha, then divided back out: average
// straight colour and the transparent black outside the mark gets a vote,
// putting a dark fringe all the way round a white logo.
//
// For shrinking. Asked to enlarge it degenerates to nearest-neighbour, because
// each output pixel then lands inside a single source pixel and there is
// nothing to average -- which is why nothing here enlarges anything.
export function resampleArea (image, box, targetWidth, targetHeight) {
  const scaleX = box.width / targetWidth
  const scaleY = box.height / targetHeight
  const out = Buffer.alloc(targetWidth * targetHeight * 4)

  for (let ty = 0; ty < targetHeight; ty++) {
    const top = box.y + ty * scaleY
    const bottom = top + scaleY

    for (let tx = 0; tx < targetWidth; tx++) {
      const left = box.x + tx * scaleX
      const right = left + scaleX

      let coverage = 0
      let alpha = 0
      let red = 0
      let green = 0
      let blue = 0

      for (let py = Math.floor(top); py < Math.ceil(bottom); py++) {
        if (py < 0 || py >= image.height) continue
        const weightY = Math.min(bottom, py + 1) - Math.max(top, py)
        if (weightY <= 0) continue

        for (let px = Math.floor(left); px < Math.ceil(right); px++) {
          if (px < 0 || px >= image.width) continue
          const weightX = Math.min(right, px + 1) - Math.max(left, px)
          if (weightX <= 0) continue

          const weight = weightX * weightY
          const i = (py * image.width + px) * 4
          const a = image.data[i + 3]

          coverage += weight
          alpha += weight * a
          red += weight * a * image.data[i]
          green += weight * a * image.data[i + 1]
          blue += weight * a * image.data[i + 2]
        }
      }

      // Nothing underneath, or nothing opaque underneath. Left as transparent
      // black, which is what the buffer already holds.
      if (coverage === 0 || alpha === 0) continue

      const o = (ty * targetWidth + tx) * 4
      out[o] = Math.round(red / alpha)
      out[o + 1] = Math.round(green / alpha)
      out[o + 2] = Math.round(blue / alpha)
      out[o + 3] = Math.round(alpha / coverage)
    }
  }

  return { width: targetWidth, height: targetHeight, data: out }
}

// Lays one image over a solid canvas, at a given offset.
//
// The blend is the ordinary source-over one. It matters that it is done here
// and not left to whoever opens the file: a promotional mark handed over as
// white-on-transparent and then dropped on white by a layout tool is a blank
// rectangle, so the versions that need a background get one baked in.
export function composite (canvasWidth, canvasHeight, background, top, offsetX, offsetY) {
  const out = Buffer.alloc(canvasWidth * canvasHeight * 4)

  for (let i = 0; i < out.length; i += 4) {
    out[i] = background[0]
    out[i + 1] = background[1]
    out[i + 2] = background[2]
    out[i + 3] = background[3]
  }

  for (let y = 0; y < top.height; y++) {
    const cy = y + offsetY
    if (cy < 0 || cy >= canvasHeight) continue

    for (let x = 0; x < top.width; x++) {
      const cx = x + offsetX
      if (cx < 0 || cx >= canvasWidth) continue

      const s = (y * top.width + x) * 4
      const a = top.data[s + 3] / 255
      if (a === 0) continue

      const d = (cy * canvasWidth + cx) * 4
      const under = out[d + 3] / 255
      const result = a + under * (1 - a)

      for (let c = 0; c < 3; c++) {
        out[d + c] = Math.round((top.data[s + c] * a + out[d + c] * under * (1 - a)) / result)
      }
      out[d + 3] = Math.round(result * 255)
    }
  }

  return { width: canvasWidth, height: canvasHeight, data: out }
}

const CRC_TABLE = (function () {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c
  }
  return table
})()

function crc32 (buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk (type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

// Encodes raw RGBA as an 8-bit PNG. Every scanline takes filter 0: these are
// written once at build time, so the bytes saved by choosing a filter per row
// are not worth the code that would choose it.
export function encodePng (image) {
  const stride = image.width * 4
  const raw = Buffer.alloc(image.height * (stride + 1))
  for (let y = 0; y < image.height; y++) {
    raw[y * (stride + 1)] = 0
    image.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(image.width, 0)
  header.writeUInt32BE(image.height, 4)
  header[8] = 8    // bit depth
  header[9] = 6    // colour type: RGBA
  header[10] = 0   // deflate
  header[11] = 0   // adaptive filtering
  header[12] = 0   // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// Crops a PNG file to its opaque bounds and resamples it to `width`.
export function scaleCropped (file, width, read) {
  const image = decodePng(read(file))
  const box = alphaBounds(image)
  const height = Math.round(width * (box.height / box.width))
  return { image: resampleArea(image, box, width, height), box }
}
