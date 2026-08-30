export function tauriBundleKinds(platform) {
  if (platform === 'win32') return ['nsis']
  if (platform === 'darwin') return ['dmg']
  if (platform === 'linux') return ['appimage', 'deb']
  throw new Error(`Unsupported Tauri desktop platform: ${platform}`)
}

export function platformSlug(platform) {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  if (platform === 'linux') return 'linux'
  throw new Error(`Unsupported Tauri desktop platform: ${platform}`)
}

export function runtimeNodeRelative(platform) {
  return platform === 'win32' ? 'node.exe' : 'bin/node'
}

export function releaseArtifactName({ version, platform, arch, extension }) {
  const slug = platformSlug(platform)
  const ext = extension.toLowerCase()
  const suffix = ext === '.exe' ? '-setup.exe' : ext === '.appimage' ? '.AppImage' : extension
  return `HarnessDock-${version}-${slug}-${arch}-full${suffix}`
}
