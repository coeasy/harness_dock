#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-update-metadata-'))
const version = '9.8.7'

try {
  await createFixtures(root, version)
  await execFileAsync(process.execPath, [
    'scripts/generate-electron-update-metadata.mjs',
    '--dir', root,
    '--version', version,
  ])
  await execFileAsync(process.execPath, [
    'scripts/generate-release-manifest.mjs',
    '--dir', root,
    '--version', version,
    '--tag', `v${version}`,
    '--repository', 'coeasy/harness_dock',
    '--host', 'electron',
  ])

  const fullWin = await readFile(path.join(root, 'full.yml'), 'utf8')
  const thinWin = await readFile(path.join(root, 'thin.yml'), 'utf8')
  const fullLinux = await readFile(path.join(root, 'full-linux.yml'), 'utf8')
  const thinLinux = await readFile(path.join(root, 'thin-linux.yml'), 'utf8')
  const fullMac = await readFile(path.join(root, 'full-mac.yml'), 'utf8')
  const legacyWin = await readFile(path.join(root, 'latest.yml'), 'utf8')

  assertIncludes(fullWin, `HarnessDock-Setup-${version}-win-x64-full.exe`, 'full Windows package')
  assertIncludes(fullWin, 'blockMapSize: 19', 'full Windows NSIS blockMapSize')
  assertIncludes(thinWin, `HarnessDock-Setup-${version}-win-x64-thin.exe`, 'thin Windows package')
  assertIncludes(thinWin, 'blockMapSize: 13', 'thin Windows NSIS blockMapSize')
  assertIncludes(fullLinux, `HarnessDock-${version}-linux-x86_64-full.AppImage`, 'full Linux AppImage')
  assertIncludes(fullLinux, 'blockMapSize: 23', 'full AppImage embedded blockMapSize')
  assertIncludes(thinLinux, 'blockMapSize: 17', 'thin AppImage embedded blockMapSize')
  assertIncludes(fullMac, `HarnessDock-${version}-mac-arm64-full.zip`, 'arm64 mac zip')
  assertIncludes(fullMac, `HarnessDock-${version}-mac-x64-full.zip`, 'x64 mac zip')
  if (legacyWin !== fullWin) throw new Error('latest.yml legacy alias must exactly mirror full.yml')

  const manifest = JSON.parse(await readFile(path.join(root, 'release-manifest.json'), 'utf8'))
  if (manifest.schemaVersion !== 2) throw new Error(`unexpected manifest schema: ${manifest.schemaVersion}`)
  const fullNsis = manifest.artifacts.find(
    (artifact) =>
      artifact.component === 'host' &&
      artifact.platform === 'win32' &&
      artifact.runtimeMode === 'full' &&
      artifact.format === 'nsis',
  )
  const thinNsis = manifest.artifacts.find(
    (artifact) =>
      artifact.component === 'host' &&
      artifact.platform === 'win32' &&
      artifact.runtimeMode === 'thin' &&
      artifact.format === 'nsis',
  )
  if (!fullNsis || !thinNsis) throw new Error('release manifest did not preserve Full/Thin NSIS identities')
  if (fullNsis.assetName === thinNsis.assetName) throw new Error('Full and Thin artifacts collapsed to the same asset')

  console.log('update metadata smoke check: OK')
} finally {
  await rm(root, { recursive: true, force: true })
}

async function createFixtures(dir, value) {
  await writeFile(path.join(dir, `HarnessDock-Setup-${value}-win-x64-full.exe`), Buffer.alloc(256, 0x31))
  await writeFile(path.join(dir, `HarnessDock-Setup-${value}-win-x64-full.exe.blockmap`), Buffer.alloc(19, 0x41))
  await writeFile(path.join(dir, `HarnessDock-Setup-${value}-win-x64-thin.exe`), Buffer.alloc(192, 0x32))
  await writeFile(path.join(dir, `HarnessDock-Setup-${value}-win-x64-thin.exe.blockmap`), Buffer.alloc(13, 0x42))

  await writeFile(
    path.join(dir, `HarnessDock-${value}-linux-x86_64-full.AppImage`),
    fakeAppImage(23, 0x51),
  )
  await writeFile(
    path.join(dir, `HarnessDock-${value}-linux-x86_64-thin.AppImage`),
    fakeAppImage(17, 0x52),
  )
  await writeFile(path.join(dir, `HarnessDock-${value}-linux-amd64-full.deb`), Buffer.alloc(90, 0x61))
  await writeFile(path.join(dir, `HarnessDock-${value}-linux-amd64-thin.deb`), Buffer.alloc(70, 0x62))

  for (const arch of ['x64', 'arm64']) {
    for (const scenario of ['full', 'thin']) {
      await writeFile(
        path.join(dir, `HarnessDock-${value}-mac-${arch}-${scenario}.zip`),
        Buffer.alloc(80, arch === 'arm64' ? 0x71 : 0x72),
      )
      await writeFile(
        path.join(dir, `HarnessDock-${value}-mac-${arch}-${scenario}.dmg`),
        Buffer.alloc(84, arch === 'arm64' ? 0x73 : 0x74),
      )
    }
  }
}

function fakeAppImage(blockMapSize, fill) {
  const body = Buffer.alloc(128, fill)
  const blockMap = Buffer.alloc(blockMapSize, fill + 1)
  const trailer = Buffer.alloc(4)
  trailer.writeUInt32BE(blockMapSize, 0)
  return Buffer.concat([body, blockMap, trailer])
}

function assertIncludes(value, needle, label) {
  if (!value.includes(needle)) throw new Error(`${label} missing: ${needle}`)
}
