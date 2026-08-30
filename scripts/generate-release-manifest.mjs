import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = parseArgs(process.argv.slice(2))
const dir = path.resolve(args.dir ?? 'artifacts')
const pkg = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'))
const version = args.version ?? pkg.version
const channel = args.channel ?? inferChannel(version)
const tag = args.tag ?? process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME ?? `v${version}`
const repository = args.repository ?? process.env.GITHUB_REPOSITORY
const host = args.host ?? process.env.HARNESSDOCK_RELEASE_HOST ?? 'electron'

if (!existsSync(dir)) throw new Error(`artifact directory not found: ${dir}`)

const names = readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isFile())
const artifacts = []
for (const name of names) {
  const parsed = parseArtifact(name, version, host)
  if (!parsed) continue
  const file = path.join(dir, name)
  artifacts.push({
    id: parsed.id,
    component: parsed.component,
    version: parsed.version,
    channel,
    platform: parsed.platform,
    arch: parsed.arch,
    ...(parsed.host ? { host: parsed.host } : {}),
    ...(parsed.runtimeMode ? { runtimeMode: parsed.runtimeMode } : {}),
    format: parsed.format,
    assetName: name,
    ...(repository && tag
      ? { url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}` }
      : {}),
    sha256: sha256File(file),
    size: statSync(file).size,
    ...(existsSync(`${file}.sig`) ? { signatureAsset: `${name}.sig` } : {}),
  })
}

artifacts.sort((a, b) => a.id.localeCompare(b.id))
if (artifacts.length === 0) throw new Error(`no recognizable HarnessDock release artifacts found under ${dir}`)

const manifest = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  release: { version, channel, tag },
  ...(repository ? { source: { provider: 'github', repository } } : { source: { provider: 'generic' } }),
  artifacts,
}

const manifestPath = path.join(dir, 'release-manifest.json')
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
writeFileSync(
  path.join(dir, 'release-manifest.sha256'),
  `${sha256File(manifestPath)}  release-manifest.json\n`,
  'utf8',
)

console.log(`release manifest: ${manifestPath}`)
console.log(`release version: ${version} (${channel})`)
console.log(`recognized artifacts: ${artifacts.length}`)
for (const artifact of artifacts) {
  console.log(`- ${artifact.component} ${artifact.platform}/${artifact.arch} ${artifact.runtimeMode ?? '-'} ${artifact.format}: ${artifact.assetName}`)
}

function parseArtifact(name, releaseVersion, releaseHost) {
  let match = /^HarnessDock-runtime-(.+)-(win32|darwin|linux)-(x64|arm64)\.tar\.gz$/.exec(name)
  if (match) {
    const [, runtimeVersion, platform, arch] = match
    return {
      id: `runtime:${platform}:${arch}:${runtimeVersion}`,
      component: 'runtime',
      version: runtimeVersion,
      platform,
      arch,
      format: 'tar.gz',
    }
  }

  match = /^HarnessDock-Setup-(.+)-win-(x64|arm64)-(full|thin)\.exe$/.exec(name)
  if (match) {
    const [, fileVersion, arch, runtimeMode] = match
    return hostArtifact(releaseHost, fileVersion, releaseVersion, 'win32', arch, runtimeMode, 'nsis')
  }

  match = /^HarnessDock-Portable-(.+)-win-(x64|arm64)-(full|thin)\.exe$/.exec(name)
  if (match) {
    const [, fileVersion, arch, runtimeMode] = match
    return hostArtifact(releaseHost, fileVersion, releaseVersion, 'win32', arch, runtimeMode, 'portable')
  }

  match = /^HarnessDock-(.+)-(win|mac|linux)-(x64|arm64|x86_64|amd64)-(full|thin)\.(zip|dmg|AppImage|deb|rpm)$/.exec(name)
  if (match) {
    const [, fileVersion, os, rawArch, runtimeMode, extension] = match
    const platform = os === 'win' ? 'win32' : os === 'mac' ? 'darwin' : 'linux'
    const arch = rawArch === 'amd64' || rawArch === 'x86_64' ? 'x64' : rawArch
    const format = extension === 'AppImage' ? 'appimage' : extension
    return hostArtifact(releaseHost, fileVersion, releaseVersion, platform, arch, runtimeMode, format)
  }

  return null
}

function hostArtifact(hostName, fileVersion, releaseVersion, platform, arch, runtimeMode, format) {
  if (fileVersion !== releaseVersion) {
    throw new Error(`host artifact version mismatch: ${fileVersion} != release ${releaseVersion}`)
  }
  return {
    id: `host:${hostName}:${platform}:${arch}:${runtimeMode}:${format}:${fileVersion}`,
    component: 'host',
    version: fileVersion,
    host: hostName,
    runtimeMode,
    platform,
    arch,
    format,
  }
}

function sha256File(file) {
  const hash = createHash('sha256')
  hash.update(readFileSync(file))
  return hash.digest('hex')
}

function inferChannel(value) {
  const normalized = String(value).toLowerCase()
  if (normalized.includes('nightly') || normalized.includes('dev')) return 'nightly'
  if (normalized.includes('-')) return 'beta'
  return 'stable'
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
