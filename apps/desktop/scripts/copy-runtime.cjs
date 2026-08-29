/**
 * electron-builder afterPack hook.
 *
 * electron-builder filters nested node_modules from extraResources, so both
 * release scenarios copy the exact prepared dsh runtime after the unpacked app
 * exists. Full copies the dedicated Node executable + modules; Thin copies the
 * same modules but reuses Electron's Node through ELECTRON_RUN_AS_NODE.
 */
const fs = require('node:fs')
const path = require('node:path')

function resolveResourceDir(context) {
  const appOutDir = context.appOutDir
  if (context.electronPlatformName !== 'darwin') {
    return path.join(appOutDir, 'resources')
  }

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
    // Normal candidates below provide the actionable error.
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
  const scenario = process.env.DSH_PACKAGE_SCENARIO === 'thin' ? 'thin' : 'full'
  fs.mkdirSync(resourceDir, { recursive: true })

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

  const dst = path.join(resourceDir, 'dsh-runtime')
  const isWindows = context.electronPlatformName === 'win32' || process.platform === 'win32'
  const runtimeNode = isWindows ? 'node.exe' : path.join('bin', 'node')
  const runtimeBinJs = path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const targetArch = ['arm64', '3'].includes(String(context.arch)) ? 'arm64' : 'x64'
  const archSpecificSrc = path.resolve(projectDir, '..', '..', 'runtimes', 'pack-' + targetArch)
  const fallbackSrc = path.resolve(projectDir, '..', '..', 'runtimes', 'pack')
  const configuredSrc = process.env.DSH_RUNTIME_DIR
    ? path.resolve(projectDir, '..', '..', process.env.DSH_RUNTIME_DIR)
    : null
  const runtimeCandidates = [configuredSrc, archSpecificSrc, fallbackSrc].filter(Boolean)
  const src = runtimeCandidates.find((candidate) =>
    fs.existsSync(path.join(candidate, runtimeBinJs)) &&
    (scenario === 'thin' || fs.existsSync(path.join(candidate, runtimeNode))),
  ) ?? runtimeCandidates[0]
  const nodeBin = path.join(src, runtimeNode)
  const binJs = path.join(src, runtimeBinJs)

  if (!fs.existsSync(binJs) || (scenario === 'full' && !fs.existsSync(nodeBin))) {
    throw new Error(
      '[afterPack] prepared runtime is incomplete at ' +
        src +
        '; expected ' +
        (scenario === 'full' ? runtimeNode + ' and ' : '') +
        'node_modules/@deepseek-ai/dsh/lib/bin.js; run pnpm prepare:runtime first',
    )
  }

  fs.rmSync(dst, { recursive: true, force: true })
  if (scenario === 'full') {
    console.log('  • afterPack: copying full dsh runtime ' + src + ' -> ' + dst)
    fs.cpSync(src, dst, { recursive: true })
  } else {
    console.log('  • afterPack: copying thin dsh module seed ' + src + ' -> ' + dst)
    fs.mkdirSync(dst, { recursive: true })
    fs.cpSync(path.join(src, 'node_modules'), path.join(dst, 'node_modules'), { recursive: true })
    for (const file of ['manifest.json', 'package.json', 'package-lock.json']) {
      const from = path.join(src, file)
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dst, file))
    }
  }

  const copiedBin = path.join(dst, runtimeBinJs)
  const copiedNode = path.join(dst, runtimeNode)
  if (!fs.existsSync(copiedBin) || (scenario === 'full' && !fs.existsSync(copiedNode))) {
    throw new Error('[afterPack] dsh runtime copy failed: ' + dst)
  }

  if (scenario === 'thin') {
    // A Thin package must not silently grow into Full. Its runtime is a module
    // seed and intentionally has no standalone Node executable.
    if (fs.existsSync(copiedNode)) {
      fs.rmSync(copiedNode, { force: true })
    }
    return
  }

  // GitHub Actions artifact ZIPs do not reliably preserve Unix executable bits.
  if (!isWindows) {
    fs.chmodSync(copiedNode, 0o755)
    const mode = fs.statSync(copiedNode).mode & 0o777
    if ((mode & 0o111) === 0) {
      throw new Error('[afterPack] bundled node is not executable after copy: ' + copiedNode)
    }
  }
}
