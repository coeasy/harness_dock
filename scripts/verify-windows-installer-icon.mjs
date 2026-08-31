#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const [exePath, icoPath] = process.argv.slice(2)
if (!exePath || !icoPath) {
  console.error('usage: node scripts/verify-windows-installer-icon.mjs <installer.exe> <brand.ico>')
  process.exit(2)
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

function icoHashes(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('invalid ICO')
  const count = buf.readUInt16LE(4)
  const hashes = new Set()
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16
    const size = buf.readUInt32LE(entry + 8)
    const offset = buf.readUInt32LE(entry + 12)
    if (size > 0 && offset + size <= buf.length) hashes.add(sha(buf.subarray(offset, offset + size)))
  }
  if (!hashes.size) throw new Error('ICO contains no image resources')
  return hashes
}

function peIconHashes(buf) {
  if (buf.length < 0x100 || buf.toString('ascii', 0, 2) !== 'MZ') throw new Error('invalid PE DOS header')
  const pe = buf.readUInt32LE(0x3c)
  if (buf.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('invalid PE signature')
  const coff = pe + 4
  const sectionCount = buf.readUInt16LE(coff + 2)
  const optionalSize = buf.readUInt16LE(coff + 16)
  const optional = coff + 20
  const magic = buf.readUInt16LE(optional)
  const dataDirs = optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : (() => { throw new Error('unsupported PE optional header') })())
  const resourceRva = buf.readUInt32LE(dataDirs + 16)
  if (!resourceRva) throw new Error('PE has no resource directory')
  const sections = []
  const sectionTable = optional + optionalSize
  for (let i = 0; i < sectionCount; i++) {
    const off = sectionTable + i * 40
    sections.push({
      virtualSize: buf.readUInt32LE(off + 8),
      virtualAddress: buf.readUInt32LE(off + 12),
      rawSize: buf.readUInt32LE(off + 16),
      rawOffset: buf.readUInt32LE(off + 20),
    })
  }
  const rvaToOffset = (rva) => {
    for (const section of sections) {
      const span = Math.max(section.virtualSize, section.rawSize)
      if (rva >= section.virtualAddress && rva < section.virtualAddress + span) return section.rawOffset + (rva - section.virtualAddress)
    }
    throw new Error(`RVA 0x${rva.toString(16)} not mapped to a PE section`)
  }
  const base = rvaToOffset(resourceRva)
  const readDir = (relative) => {
    const off = base + relative
    const count = buf.readUInt16LE(off + 12) + buf.readUInt16LE(off + 14)
    const entries = []
    for (let i = 0; i < count; i++) {
      const e = off + 16 + i * 8
      const name = buf.readUInt32LE(e)
      const target = buf.readUInt32LE(e + 4)
      entries.push({ id: (name & 0x80000000) ? null : name & 0xffff, isDir: Boolean(target & 0x80000000), relative: target & 0x7fffffff })
    }
    return entries
  }
  const type = readDir(0).find((entry) => entry.id === 3 && entry.isDir)
  if (!type) throw new Error('PE has no RT_ICON resources')
  const hashes = new Set()
  for (const icon of readDir(type.relative)) {
    if (!icon.isDir) continue
    for (const language of readDir(icon.relative)) {
      if (language.isDir) continue
      const data = base + language.relative
      const dataRva = buf.readUInt32LE(data)
      const size = buf.readUInt32LE(data + 4)
      const offset = rvaToOffset(dataRva)
      if (size > 0 && offset + size <= buf.length) hashes.add(sha(buf.subarray(offset, offset + size)))
    }
  }
  if (!hashes.size) throw new Error('PE RT_ICON directory is empty')
  return hashes
}

try {
  const expected = icoHashes(readFileSync(icoPath))
  const actual = peIconHashes(readFileSync(exePath))
  const matches = [...expected].filter((value) => actual.has(value))
  if (matches.length === 0) throw new Error(`installer icon does not contain any HarnessDock ICO image (${actual.size} PE icons checked)`)
  console.log(`installer icon verified: ${matches.length}/${expected.size} HarnessDock icon images matched`)
} catch (error) {
  console.error(`installer icon verification failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
