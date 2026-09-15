/**
 * Desktop build target policy.
 *
 * The native host orchestration is shared, but Runtime identity, packaging
 * format, CI runner and post-build expectations are platform/architecture
 * specific. Keep those differences explicit here instead of deriving a generic
 * Tauri default that changes when upstream tooling changes.
 */
const TARGETS = Object.freeze({
  'win32-x64': Object.freeze({
    id: 'windows-x64',
    platform: 'win32',
    arch: 'x64',
    runtimeKey: 'win32-x64',
    bundles: Object.freeze(['nsis']),
    artifactKind: 'NSIS installer',
    ciRunner: 'windows-latest',
    installedStartupSmoke: true,
  }),
  'linux-x64': Object.freeze({
    id: 'linux-x64',
    platform: 'linux',
    arch: 'x64',
    runtimeKey: 'linux-x64',
    bundles: Object.freeze(['deb', 'appimage']),
    artifactKind: 'DEB + AppImage',
    ciRunner: 'ubuntu-22.04',
    installedStartupSmoke: false,
  }),
  'darwin-x64': Object.freeze({
    id: 'macos-x64',
    platform: 'darwin',
    arch: 'x64',
    runtimeKey: 'darwin-x64',
    bundles: Object.freeze(['app']),
    artifactKind: '.app bundle',
    ciRunner: 'macos-15-intel',
    installedStartupSmoke: false,
  }),
  'darwin-arm64': Object.freeze({
    id: 'macos-arm64',
    platform: 'darwin',
    arch: 'arm64',
    runtimeKey: 'darwin-arm64',
    bundles: Object.freeze(['app']),
    artifactKind: '.app bundle',
    ciRunner: 'macos-latest',
    installedStartupSmoke: false,
  }),
})

function normalizedArch(arch) {
  if (arch === 'x64' || arch === 'arm64') return arch
  return arch
}

export function resolveDesktopBuildTarget(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${normalizedArch(arch)}`
  const target = TARGETS[key]
  if (!target) {
    throw new Error(
      `unsupported local desktop build target ${key}; supported targets: ${Object.keys(TARGETS).join(', ')}`,
    )
  }
  return { ...target, bundles: [...target.bundles] }
}

export function tauriBundleArgument(target) {
  if (!target?.bundles?.length) throw new Error('desktop build target has no Tauri bundle policy')
  return target.bundles.join(',')
}

export const DESKTOP_BUILD_TARGETS = TARGETS
