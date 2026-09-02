#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function parsePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('small icon is not a PNG')
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
  if (!ihdr || idat.length === 0) throw new Error('small icon is missing IHDR or IDAT data')
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const bitDepth = ihdr[8]
  const colorType = ihdr[9]
  const interlace = ihdr[12]
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`small icon must be non-interlaced 8-bit RGBA; got depth=${bitDepth}, type=${colorType}, interlace=${interlace}`)
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
  const pixels = Buffer.alloc(stride * height)
  let source = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source++]
    const row = y * stride
    const previous = row - stride
    for (let x = 0; x < stride; x += 1) {
      const encoded = raw[source + x]
      const left = x >= bpp ? pixels[row + x - bpp] : 0
      const up = y > 0 ? pixels[previous + x] : 0
      const upLeft = y > 0 && x >= bpp ? pixels[previous + x - bpp] : 0
      if (filter === 0) pixels[row + x] = encoded
      else if (filter === 1) pixels[row + x] = (encoded + left) & 0xff
      else if (filter === 2) pixels[row + x] = (encoded + up) & 0xff
      else if (filter === 3) pixels[row + x] = (encoded + Math.floor((left + up) / 2)) & 0xff
      else if (filter === 4) pixels[row + x] = (encoded + paeth(left, up, upLeft)) & 0xff
      else throw new Error(`unsupported PNG filter ${filter}`)
    }
    source += stride
  }
  return pixels
}

function averageCorner(pixels, width, height) {
  const points = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]
  return [0, 1, 2, 3].map((channel) => Math.round(points.reduce((sum, [x, y]) => {
    return sum + pixels[(y * width + x) * 4 + channel]
  }, 0) / points.length))
}

function findArtworkBounds(pixels, width, height) {
  const background = averageCorner(pixels, width, height)
  const transparentBackground = background[3] <= 16
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      const alpha = pixels[i + 3]
      const distance = Math.abs(pixels[i] - background[0])
        + Math.abs(pixels[i + 1] - background[1])
        + Math.abs(pixels[i + 2] - background[2])
      const visible = transparentBackground
        ? alpha > 12
        : alpha > 12 && (distance > 24 || Math.abs(alpha - background[3]) > 12)
      if (!visible) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }

  if (maxX < minX || maxY < minY) throw new Error('small icon contains no detectable foreground artwork')
  return { minX, minY, maxX, maxY }
}

const [iconPath, minimumRaw = '0.90'] = process.argv.slice(2)
if (!iconPath) {
  console.error('Usage: node scripts/verify-small-icon.mjs <32x32.png> [minimum-occupancy]')
  process.exit(2)
}

const minimum = Number(minimumRaw)
if (!Number.isFinite(minimum) || minimum <= 0 || minimum > 1) throw new Error(`invalid minimum occupancy: ${minimumRaw}`)

const decoded = parsePng(readFileSync(iconPath))
if (decoded.width > 64 || decoded.height > 64) throw new Error(`expected a small icon, got ${decoded.width}x${decoded.height}`)
const pixels = unfilter(decoded)
const bounds = findArtworkBounds(pixels, decoded.width, decoded.height)
const artworkWidth = bounds.maxX - bounds.minX + 1
const artworkHeight = bounds.maxY - bounds.minY + 1
const horizontalOccupancy = artworkWidth / decoded.width
const verticalOccupancy = artworkHeight / decoded.height
const minimumOccupancy = Math.min(horizontalOccupancy, verticalOccupancy)
const maxEdgeGap = Math.max(bounds.minX, bounds.minY, decoded.width - 1 - bounds.maxX, decoded.height - 1 - bounds.maxY)

if (minimumOccupancy < minimum) {
  throw new Error(`small icon artwork fills ${(horizontalOccupancy * 100).toFixed(1)}% x ${(verticalOccupancy * 100).toFixed(1)}% of the canvas; both axes require ${(minimum * 100).toFixed(1)}%`)
}
if (maxEdgeGap > 2) {
  throw new Error(`small icon still has a ${maxEdgeGap}px outer gap; expected no more than 2px`)
}

console.log(`small icon fill OK: ${decoded.width}x${decoded.height}, occupancy ${(horizontalOccupancy * 100).toFixed(1)}% x ${(verticalOccupancy * 100).toFixed(1)}%, max edge gap ${maxEdgeGap}px`)
