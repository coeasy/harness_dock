import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = parseArgs(process.argv.slice(2))
const dir = path.resolve(args.dir ?? 'artifacts')
const version = args.version ?? JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')).version
const releaseDate = new Date().toISOString()
const names = readdirSync(dir)

for (const scenario of ['full', 'thin']) {
  writeWindowsChannel(scenario)
  writeMacChannel(scenario)
  writeLinuxChannel(scenario)
}

function writeWindowsChannel(scenario) {
  const installer = findExact(new RegExp(`^HarnessDock-Setup-${escapeRegex(version)}-win-(x64|arm64)-${scenario}\\.exe$`))
  if (!installer) return
  writeChannel(`${scenario}.yml`, [installer], installer, scenario === 'full' ? 'latest.yml' : undefined)
}

function writeMacChannel(scenario) {
  const files = names
    .filter((name) => new RegExp(`^HarnessDock-${escapeRegex(version)}-mac-(x64|arm64)-${scenario}\\.(zip|dmg)$`).test(name))
    .sort((a, b) => {
      const aZip = a.endsWith('.zip') ? 0 : 1
      const bZip = b.endsWith('.zip') ? 0 : 1
      return aZip - bZip || a.localeCompare(b)
    })
  if (files.length === 0) return
  const primary = files.find((name) => name.endsWith('.zip')) ?? files[0]
  writeChannel(`${scenario}-mac.yml`, files, primary, scenario === 'full' ? 'latest-mac.yml' : undefined)
}

function writeLinuxChannel(scenario) {
  const appImage = findExact(new RegExp(`^HarnessDock-${escapeRegex(version)}-linux-(x64|x86_64)-${scenario}\\.AppImage$`))
  if (!appImage) return
  writeChannel(`${scenario}-linux.yml`, [appImage], appImage, scenario === 'full' ? 'latest-linux.yml' : undefined)
}

function writeChannel(output, fileNames, primaryName, legacyAlias) {
  const files = fileNames.map((name) => {
    const file = path.join(dir, name)
    return {
      name,
      sha512: sha512File(file),
      size: statSync(file).size,
      blockMapSize: differentialBlockMapSize(file),
    }
  })
  const primary = files.find((file) => file.name === primaryName)
  if (!primary) throw new Error(`primary update file missing from metadata list: ${primaryName}`)

  let yml = `version: ${version}\nfiles:\n`
  for (const file of files) {
    yml += `  - url: ${file.name}\n    sha512: ${file.sha512}\n    size: ${file.size}\n`
    if (file.blockMapSize !== undefined) yml += `    blockMapSize: ${file.blockMapSize}\n`
  }
  // path/sha512 remain for compatibility with older electron-updater readers.
  yml += `path: ${primary.name}\nsha512: ${primary.sha512}\nreleaseDate: '${releaseDate}'\n`
  writeFileSync(path.join(dir, output), yml, 'utf8')
  console.log(
    `electron update metadata: ${output} -> ${primary.name}` +
      `${primary.blockMapSize ? ` (blockMapSize=${primary.blockMapSize})` : ' (full-download fallback)'}`,
  )

  // v0.1.1 baked the default `latest` channel into both Full and Thin. The
  // first v0.2 release keeps a legacy alias pointing at the reliable Full
  // package so those installations can migrate. New v0.2 installations use
  // explicit full/thin channels and never read latest* again.
  if (legacyAlias) {
    writeFileSync(path.join(dir, legacyAlias), yml, 'utf8')
    console.log(`legacy update alias: ${legacyAlias} -> ${output}`)
  }
}

/**
 * electron-updater uses two different differential layouts:
 * - NSIS: a `<installer>.blockmap` sidecar;
 * - AppImage: a deflated blockmap embedded at the end of the AppImage followed
 *   by a 4-byte big-endian blockmap length.
 *
 * macOS remains full-download fallback here. Its updater can use zip sidecars,
 * but the v0.2 migration intentionally prioritizes signed/reliable replacement
 * over a second binary-delta path while Tauri is being introduced.
 */
function differentialBlockMapSize(file) {
  if (file.endsWith('.exe')) {
    const sidecar = `${file}.blockmap`
    return existsSync(sidecar) ? statSync(sidecar).size : undefined
  }
  if (file.endsWith('.AppImage')) return embeddedAppImageBlockMapSize(file)
  return undefined
}

function embeddedAppImageBlockMapSize(file) {
  const size = statSync(file).size
  if (size < 4) throw new Error(`AppImage is too small to contain an embedded blockmap: ${file}`)
  const fd = openSync(file, 'r')
  try {
    const trailer = Buffer.alloc(4)
    const bytes = readSync(fd, trailer, 0, 4, size - 4)
    if (bytes !== 4) throw new Error(`short read while reading AppImage blockmap trailer: ${file}`)
    const blockMapSize = trailer.readUInt32BE(0)
    if (blockMapSize <= 0 || blockMapSize + 4 >= size) {
      throw new Error(`invalid embedded AppImage blockmap size ${blockMapSize}: ${file}`)
    }
    return blockMapSize
  } finally {
    closeSync(fd)
  }
}

function findExact(pattern) {
  const matches = names.filter((name) => pattern.test(name))
  if (matches.length > 1) throw new Error(`ambiguous release assets for ${pattern}: ${matches.join(', ')}`)
  return matches[0]
}

function sha512File(file) {
  if (!existsSync(file)) throw new Error(`missing update asset: ${file}`)
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`)
    result[key] = value
    index += 1
  }
  return result
}
