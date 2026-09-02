/**
 * electron-builder afterPack hook.
 *
 * electron-builder forcibly excludes any directory named node_modules from
 * copied resources (extraResources filters cannot override this). The bundled
 * dsh runtime therefore needs to be copied after electron-builder has created
 * the unpacked application.
 *
 * Source of truth for the runtime layout lives in
 * packages/client-runtime/src/prepare-cli.ts (runtimes/pack).
 */
const fs = require('node:fs')
const path = require('node:path')

function resolveResourceDir(context) {
  const appOutDir = context.appOutDir
  if (context.electronPlatformName !== 'darwin') {
    return path.join(appOutDir, 'resources')
  }

  // On macOS electron-builder may pass either the .app bundle or its parent
  // architecture directory as appOutDir. Resolve the actual Contents/Resources
  // directory so full packages work for both Intel and Apple Silicon builds.
  const candidates = [
    path.join(appOutDir, 'Contents', 'Resources'),
    path.join(appOutDir, 'Resources'),
  ]
  try {
    for (const entry of fs.readdirSync(appOutDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.endsWith('.app')) {
        candidates.push(path.join(appOutDir, entry.name, 'Contents', 'Resources'))
      }
    }
  } catch {
    // The normal candidates below provide the actionable error.
  }
  const existing = candidates.find((candidate) => fs.existsSync(candidate))
  if (!existing) {
    throw new Error('[afterPack] macOS app Resources directory not found under ' + appOutDir)
  }
  return existing
}

/** @param {import('app-builder-lib').AfterPackContext} context */
exports.default = async function afterPack(context) {
  const projectDir = context.projectDir ?? context.packager.projectDir
  const resourceDir = resolveResourceDir(context)
  fs.mkdirSync(resourceDir, { recursive: true })

  // Copy the embedded plugin explicitly. This is done in afterPack because
  // electron-builder's extraResources staging is not consistent when the
  // source package is a workspace dependency.
  const pluginSrc = path.resolve(projectDir, '..', '..', 'packages', 'plugin-embedded-client', 'lib')
  const pluginEntrySrc = path.join(pluginSrc, 'index.js')
  if (!fs.existsSync(pluginEntrySrc)) {
    throw new Error('[afterPack] embedded-client source bundle missing: ' + pluginEntrySrc)
  }
  const pluginDst = path.join(resourceDir, 'plugin-embedded-client')
  fs.rmSync(pluginDst, { recursive: true, force: true })
  fs.cpSync(pluginSrc, pluginDst, { recursive: true })
  const pluginEntry = path.join(pluginDst, 'index.js')
  if (!fs.existsSync(pluginEntry)) {
    throw new Error('[afterPack] embedded-client plugin copy failed: ' + pluginEntry)
  }

  const compatibilitySrc = path.resolve(
    projectDir,
    '..',
    'tauri',
    'src-tauri',
    'resources',
    'dsh-client-runtime-compat',
  )
  const compatibilityEntrySrc = path.join(compatibilitySrc, 'index.js')
  if (!fs.existsSync(compatibilityEntrySrc)) {
    throw new Error('[afterPack] client-runtime compatibility source missing: ' + compatibilityEntrySrc)
  }
  const compatibilityDst = path.join(resourceDir, 'dsh-client-runtime-compat')
  fs.rmSync(compatibilityDst, { recursive: true, force: true })
  fs.cpSync(compatibilitySrc, compatibilityDst, { recursive: true })
  if (!fs.existsSync(path.join(compatibilityDst, 'client.js'))) {
    throw new Error('[afterPack] client-runtime compatibility copy failed: ' + compatibilityDst)
  }

  const shellSrc = path.resolve(projectDir, '..', '..', 'packages', 'plugin-harness-shell', 'lib')
  const shellEntrySrc = path.join(shellSrc, 'index.js')
  if (!fs.existsSync(shellEntrySrc)) {
    throw new Error('[afterPack] Harness Shell plugin source bundle missing: ' + shellEntrySrc)
  }
  const shellDst = path.join(resourceDir, 'plugin-harness-shell')
  fs.rmSync(shellDst, { recursive: true, force: true })
  fs.cpSync(shellSrc, shellDst, { recursive: true })
  if (!fs.existsSync(path.join(shellDst, 'index.js'))) {
    throw new Error('[afterPack] Harness Shell plugin copy failed: ' + shellDst)
  }

  // This hook is attached only to electron-builder.full.yml. Do not depend on
  // extraResources having created dsh-runtime first: that staging step may
  // omit node_modules and leave no destination directory at all. An earlier
  // guard returned in that case, producing a full installer that silently fell
  // back to the slow first-launch network download.
  const dst = path.join(resourceDir, 'dsh-runtime')
  const isWindows = context.electronPlatformName === 'win32' || process.platform === 'win32'
  const runtimeNode = isWindows ? 'node.exe' : path.join('bin', 'node')
  const runtimeBinJs = path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  // Prefer the exact directory downloaded by CI. electron-builder exposes
  // context.arch as a numeric Arch enum on some versions (arm64 = 3), so
  // relying on a string comparison silently selected the x64 runtime.
  const targetArch = ['arm64', '3'].includes(String(context.arch)) ? 'arm64' : 'x64'
  const archSpecificSrc = path.resolve(projectDir, '..', '..', 'runtimes', 'pack-' + targetArch)
  const fallbackSrc = path.resolve(projectDir, '..', '..', 'runtimes', 'pack')
  const configuredSrc = process.env.DSH_RUNTIME_DIR
    ? path.resolve(projectDir, '..', '..', process.env.DSH_RUNTIME_DIR)
    : null
  const runtimeCandidates = [configuredSrc, archSpecificSrc, fallbackSrc].filter(Boolean)
  const src = runtimeCandidates.find((candidate) =>
    fs.existsSync(path.join(candidate, runtimeNode)) &&
    fs.existsSync(path.join(candidate, runtimeBinJs)),
  ) ?? runtimeCandidates[0]
  const nodeBin = path.join(src, runtimeNode)
  const binJs = path.join(src, runtimeBinJs)

  if (!fs.existsSync(nodeBin) || !fs.existsSync(binJs)) {
    throw new Error(
      '[afterPack] bundled runtime is incomplete at ' +
        src +
        '; expected ' +
        runtimeNode +
        ' and node_modules/@deepseek-ai/dsh/lib/bin.js; run pnpm prepare:runtime first',
    )
  }

  console.log('  • afterPack: copying full dsh runtime ' + src + ' -> ' + dst)
  fs.rmSync(dst, { recursive: true, force: true })
  fs.cpSync(src, dst, { recursive: true })

  const copiedBin = path.join(dst, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const copiedNode = path.join(dst, runtimeNode)
  if (!fs.existsSync(copiedNode) || !fs.existsSync(copiedBin)) {
    throw new Error('[afterPack] dsh runtime copy failed: ' + dst)
  }

  // GitHub Actions artifacts are ZIP archives and do not reliably preserve
  // Unix executable bits. Full packages are assembled from a downloaded
  // runtime artifact, so explicitly restore Node's executable permission after
  // copying it into the final app. afterPack runs before code signing, which
  // keeps this compatible with future signed/notarized macOS releases.
  if (!isWindows) {
    fs.chmodSync(copiedNode, 0o755)
    const mode = fs.statSync(copiedNode).mode & 0o777
    if ((mode & 0o111) === 0) {
      throw new Error('[afterPack] bundled node is not executable after copy: ' + copiedNode)
    }
  }
}
