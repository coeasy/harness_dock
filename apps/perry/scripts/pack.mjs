#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const here = path.dirname(fileURLToPath(import.meta.url))
const perryRoot = path.resolve(here, '..')
const repoRoot = path.resolve(perryRoot, '../..')
const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const version = rootPackage.version
const PERRY_VERSION = process.env.PERRY_VERSION || '0.5.1220'

const { values } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'thin' },
    help: { type: 'boolean', default: false },
  },
})

if (values.help) {
  console.log('Usage: node apps/perry/scripts/pack.mjs --scenario thin|full')
  process.exit(0)
}
if (!['thin', 'full'].includes(values.scenario)) {
  throw new Error(`Unknown --scenario ${values.scenario}; expected thin or full`)
}

const scenario = values.scenario
const platformName = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform]
if (!platformName) throw new Error(`Perry Preview packaging is not configured for ${process.platform}`)
const arch = process.arch
const baseName = `HarnessDock-Native-Preview-${version}-${platformName}-${arch}-${scenario}`
const releaseRoot = path.join(perryRoot, 'release', scenario)
const stagingRoot = path.join(releaseRoot, 'staging')
const artifactsRoot = path.join(releaseRoot, 'artifacts')
const perryBin = process.env.PERRY_BIN || 'perry'
const runtimeDir = path.resolve(process.env.DSH_RUNTIME_DIR || path.join(repoRoot, 'runtimes', 'pack'))

function run(command, args, cwd = repoRoot, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    console.log(`[perry-pack] ${command} ${args.join(' ')}`)
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code}`))
    })
  })
}

function sha256(file) {
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
  writeFileSync(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`, 'utf8')
}

function copySharedResources(resourcesDir) {
  mkdirSync(resourcesDir, { recursive: true })
  cpSync(path.join(repoRoot, 'packages', 'docs-sync', 'origin.json'), path.join(resourcesDir, 'origin.json'))
  cpSync(
    path.join(repoRoot, 'packages', 'plugin-embedded-client', 'lib'),
    path.join(resourcesDir, 'plugin-embedded-client'),
    { recursive: true },
  )
  const icon = path.join(repoRoot, 'apps', 'desktop', 'build', 'icon-256.png')
  if (existsSync(icon)) cpSync(icon, path.join(resourcesDir, 'icon-256.png'))
  writeFileSync(
    path.join(resourcesDir, 'host-manifest.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      host: 'perry',
      channel: 'preview',
      appId: 'com.dsh.client.perry.preview',
      version,
      perryVersion: PERRY_VERSION,
      scenario,
      platform: process.platform,
      arch,
      capabilities: {
        downloads: false,
        filePicker: false,
        nativeJsBridge: false,
        serviceWorkers: false,
        autoUpdate: false,
      },
    }, null, 2)}\n`,
    'utf8',
  )
  if (scenario === 'full') {
    if (!existsSync(runtimeDir)) throw new Error(`Prepared runtime is missing: ${runtimeDir}`)
    cpSync(runtimeDir, path.join(resourcesDir, 'dsh-runtime'), { recursive: true })
  }
}

async function prepareRuntimeIfNeeded() {
  if (scenario !== 'full' || process.env.DSH_SKIP_RUNTIME_PREPARE === '1') return
  await run(
    'pnpm',
    ['--filter', '@dsh/client-runtime', 'bundle-runtime'],
    repoRoot,
    {
      DSH_RUNTIME_PLATFORM: process.platform,
      DSH_RUNTIME_ARCH: arch,
      DSH_RUNTIME_DIR: runtimeDir,
    },
  )
}

async function compileBinary(output) {
  mkdirSync(path.dirname(output), { recursive: true })
  if (process.env.DSH_PERRY_SKIP_CHECK !== '1') {
    await run(perryBin, ['check', 'src/main.ts', '--strict'], perryRoot)
  }
  await run(perryBin, ['compile', 'src/main.ts', '-o', output], perryRoot)
  if (process.platform !== 'win32') chmodSync(output, 0o755)
}

async function packageWindows() {
  const bundleDir = path.join(stagingRoot, baseName)
  const exe = path.join(bundleDir, 'HarnessDock-Native-Preview.exe')
  await compileBinary(exe)
  copySharedResources(path.join(bundleDir, 'resources'))
  const zip = path.join(artifactsRoot, `${baseName}.zip`)
  const q = (value) => `'${value.replaceAll("'", "''")}'`
  await run(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path ${q(path.join(bundleDir, '*'))} -DestinationPath ${q(zip)} -Force`,
    ],
    repoRoot,
  )
  sha256(zip)
}

async function packageMac() {
  const app = path.join(stagingRoot, 'HarnessDock Native Preview.app')
  const contents = path.join(app, 'Contents')
  const macos = path.join(contents, 'MacOS')
  const resources = path.join(contents, 'Resources')
  const executable = path.join(macos, 'HarnessDock-Native-Preview')
  mkdirSync(macos, { recursive: true })
  await compileBinary(executable)
  copySharedResources(resources)
  writeFileSync(
    path.join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>CFBundleDisplayName</key><string>HarnessDock Native Preview</string>\n<key>CFBundleExecutable</key><string>HarnessDock-Native-Preview</string>\n<key>CFBundleIdentifier</key><string>com.dsh.client.perry.preview</string>\n<key>CFBundleName</key><string>HarnessDock Native Preview</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n<key>CFBundleShortVersionString</key><string>${version}</string>\n<key>CFBundleVersion</key><string>${version}</string>\n<key>LSMinimumSystemVersion</key><string>13.0</string>\n<key>NSHighResolutionCapable</key><true/>\n</dict></plist>\n`,
    'utf8',
  )

  const zip = path.join(artifactsRoot, `${baseName}.zip`)
  const dmg = path.join(artifactsRoot, `${baseName}.dmg`)
  await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip], repoRoot)
  await run(
    'hdiutil',
    ['create', '-volname', 'HarnessDock Native Preview', '-srcfolder', app, '-ov', '-format', 'UDZO', dmg],
    repoRoot,
  )
  sha256(zip)
  sha256(dmg)
}

async function packageLinux() {
  const bundleDir = path.join(stagingRoot, baseName)
  const executable = path.join(bundleDir, 'harnessdock-native-preview')
  await compileBinary(executable)
  copySharedResources(path.join(bundleDir, 'resources'))

  const tarball = path.join(artifactsRoot, `${baseName}.tar.gz`)
  await run('tar', ['-czf', tarball, '-C', stagingRoot, baseName], repoRoot)
  sha256(tarball)

  const debRoot = path.join(stagingRoot, 'deb-root')
  const installRoot = path.join(debRoot, 'usr', 'lib', 'harnessdock-native-preview')
  const binRoot = path.join(debRoot, 'usr', 'bin')
  const desktopRoot = path.join(debRoot, 'usr', 'share', 'applications')
  const pixmapRoot = path.join(debRoot, 'usr', 'share', 'pixmaps')
  mkdirSync(path.join(debRoot, 'DEBIAN'), { recursive: true })
  mkdirSync(path.dirname(installRoot), { recursive: true })
  cpSync(bundleDir, installRoot, { recursive: true })
  mkdirSync(binRoot, { recursive: true })
  symlinkSync('../lib/harnessdock-native-preview/harnessdock-native-preview', path.join(binRoot, 'harnessdock-native-preview'))
  mkdirSync(desktopRoot, { recursive: true })
  writeFileSync(
    path.join(desktopRoot, 'harnessdock-native-preview.desktop'),
    `[Desktop Entry]\nName=HarnessDock Native Preview\nExec=harnessdock-native-preview\nIcon=harnessdock-native-preview\nType=Application\nCategories=Development;\nTerminal=false\n`,
    'utf8',
  )
  const icon = path.join(bundleDir, 'resources', 'icon-256.png')
  if (existsSync(icon)) {
    mkdirSync(pixmapRoot, { recursive: true })
    cpSync(icon, path.join(pixmapRoot, 'harnessdock-native-preview.png'))
  }
  const debArch = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : arch
  writeFileSync(
    path.join(debRoot, 'DEBIAN', 'control'),
    `Package: harnessdock-native-preview\nVersion: ${version}\nSection: devel\nPriority: optional\nArchitecture: ${debArch}\nMaintainer: HarnessDock contributors\nDescription: HarnessDock Perry native preview host\n`,
    'utf8',
  )
  const deb = path.join(artifactsRoot, `${baseName}.deb`)
  await run('dpkg-deb', ['--build', '--root-owner-group', debRoot, deb], repoRoot)
  sha256(deb)
}

async function main() {
  rmSync(releaseRoot, { recursive: true, force: true })
  mkdirSync(stagingRoot, { recursive: true })
  mkdirSync(artifactsRoot, { recursive: true })

  await run('pnpm', ['--filter', '@dsh/plugin-embedded-client', 'bundle'], repoRoot)
  await prepareRuntimeIfNeeded()

  if (process.platform === 'win32') await packageWindows()
  else if (process.platform === 'darwin') await packageMac()
  else await packageLinux()

  console.log(`[perry-pack] done: Perry ${PERRY_VERSION}, ${platformName}/${arch}, ${scenario}`)
  console.log(`[perry-pack] artifacts: ${artifactsRoot}`)
}

main().catch((error) => {
  console.error(`[perry-pack] FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
