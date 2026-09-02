#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
// Deliberately overscan the detected artwork by 2%. This removes the visible
// safety ring that becomes disproportionately large at 16/24/32 px while
// preserving the source aspect ratio and letting the platform apply its own
// icon mask/inset rules.
const TARGET_OCCUPANCY = 1.02

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii')
  const size = Buffer.allocUnsafe(4)
  size.writeUInt32BE(data.length)
  const checksum = Buffer.allocUnsafe(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([size, name, data, checksum])
}

function parsePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Icon source is not a PNG file')
  let offset = 8
  let ihdr
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') ihdr = data
    if (type === 'IDAT') idat.push(data)
    if (type === 'IEND') break
  }
  if (!ihdr || idat.length === 0) throw new Error('Icon PNG is missing IHDR or IDAT data')
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const bitDepth = ihdr[8]
  const colorType = ihdr[9]
  const interlace = ihdr[12]
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`Icon PNG must be non-interlaced 8-bit RGBA (got depth=${bitDepth}, colorType=${colorType}, interlace=${interlace})`)
  }
  return { width, height, raw: inflateSync(Buffer.concat(idat)) }
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

function unfilter({ width, height, raw }) {
  const bpp = 4
  const stride = width * bpp
  const pixels = Buffer.allocUnsafe(stride * height)
  let source = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source]
    source += 1
    const row = y * stride
    const previous = row - stride
    for (let x = 0; x < stride; x += 1) {
      const encoded = raw[source + x]
      const left = x >= bpp ? pixels[row + x - bpp] : 0
      const up = y > 0 ? pixels[previous + x] : 0
      const upLeft = y > 0 && x >= bpp ? pixels[previous + x - bpp] : 0
      let value
      if (filter === 0) value = encoded
      else if (filter === 1) value = (encoded + left) & 0xff
      else if (filter === 2) value = (encoded + up) & 0xff
      else if (filter === 3) value = (encoded + Math.floor((left + up) / 2)) & 0xff
      else if (filter === 4) value = (encoded + paeth(left, up, upLeft)) & 0xff
      else throw new Error(`Unsupported PNG filter ${filter}`)
      pixels[row + x] = value
    }
    source += stride
  }
  return pixels
}

function cornerBackground(pixels, width, height) {
  const points = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]
  const values = points.map(([x, y]) => {
    const i = (y * width + x) * 4
    return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]]
  })
  return [0, 1, 2, 3].map((channel) => Math.round(values.reduce((sum, value) => sum + value[channel], 0) / values.length))
}

function contentBounds(pixels, width, height) {
  const background = cornerBackground(pixels, width, height)
  const transparentBackground = background[3] <= 16
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      const alpha = pixels[i + 3]
      const distance = Math.abs(pixels[i] - background[0]) + Math.abs(pixels[i + 1] - background[1]) + Math.abs(pixels[i + 2] - background[2])
      const visible = transparentBackground ? alpha > 12 : alpha > 12 && (distance > 30 || Math.abs(alpha - background[3]) > 12)
      if (!visible) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }
  if (maxX < minX || maxY < minY) return { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1, background }
  return { minX, minY, maxX, maxY, background }
}

function normalize(pixels, width, height) {
  const bounds = contentBounds(pixels, width, height)
  const contentWidth = bounds.maxX - bounds.minX + 1
  const contentHeight = bounds.maxY - bounds.minY + 1
  const dominantSpan = Math.max(contentWidth, contentHeight)
  // No synthetic outer padding. A tiny 2% bleed removes residual source-art
  // whitespace so small taskbar/tray icons visually fill the available square.
  const side = dominantSpan / TARGET_OCCUPANCY
  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerY = (bounds.minY + bounds.maxY) / 2
  const left = centerX - side / 2
  const top = centerY - side / 2
  const output = Buffer.alloc(width * height * 4)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = left + ((x + 0.5) / width) * side - 0.5
      const sourceY = top + ((y + 0.5) / height) * side - 0.5
      const x0 = Math.floor(sourceX)
      const y0 = Math.floor(sourceY)
      const fx = sourceX - x0
      const fy = sourceY - y0
      const target = (y * width + x) * 4
      for (let channel = 0; channel < 4; channel += 1) {
        let value = 0
        for (let dy = 0; dy <= 1; dy += 1) {
          for (let dx = 0; dx <= 1; dx += 1) {
            const sx = x0 + dx
            const sy = y0 + dy
            const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy)
            const sample = sx >= 0 && sx < width && sy >= 0 && sy < height
              ? pixels[(sy * width + sx) * 4 + channel]
              : bounds.background[channel]
            value += sample * weight
          }
        }
        output[target + channel] = Math.max(0, Math.min(255, Math.round(value)))
      }
    }
  }

  const occupancyBefore = Math.max(contentWidth / width, contentHeight / height)
  const occupancyAfter = dominantSpan / side
  return { pixels: output, occupancyBefore, occupancyAfter }
}

function encodePng(pixels, width, height) {
  const stride = width * 4
  const scanlines = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const outputRow = y * (stride + 1)
    scanlines[outputRow] = 0
    pixels.copy(scanlines, outputRow + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const [input, output] = process.argv.slice(2)
if (!input || !output) {
  console.error('Usage: node scripts/normalize-icon.mjs <input.png> <output.png>')
  process.exit(2)
}

const decoded = parsePng(readFileSync(input))
const pixels = unfilter(decoded)
const normalized = normalize(pixels, decoded.width, decoded.height)
writeFileSync(output, encodePng(normalized.pixels, decoded.width, decoded.height))
console.log(`icon tight-fill: occupancy ${(normalized.occupancyBefore * 100).toFixed(1)}% -> ${(normalized.occupancyAfter * 100).toFixed(1)}% (2% bleed)`)
