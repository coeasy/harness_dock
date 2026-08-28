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

/** @param {import('app-builder-lib').AfterPackContext} context */
exports.default = async function afterPack(context) {
  const projectDir = context.projectDir ?? context.packager.projectDir
  const resourceDir = path.join(context.appOutDir, 'resources')
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

  // This hook is attached only to electron-builder.full.yml. Do not depend on
  // extraResources having created dsh-runtime first: that staging step may
  // omit node_modules and leave no destination directory at all. An earlier
  // guard returned in that case, producing a full installer that silently fell
  // back to the slow first-launch network download.
  const dst = path.join(resourceDir, 'dsh-runtime')
  const targetArch = String(context.arch) === 'arm64' ? 'arm64' : 'x64'
  const archSpecificSrc = path.resolve(projectDir, '..', '..', 'runtimes', 'pack-' + targetArch)
  const fallbackSrc = path.resolve(projectDir, '..', '..', 'runtimes', 'pack')
  const isWindows = context.electronPlatformName === 'win32' || process.platform === 'win32'
  const runtimeNode = isWindows ? 'node.exe' : path.join('bin', 'node')
  const src = fs.existsSync(path.join(archSpecificSrc, runtimeNode))
    ? archSpecificSrc
    : fallbackSrc
  const nodeBin = path.join(src, runtimeNode)
  const binJs = path.join(src, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

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
}
