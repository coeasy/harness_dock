/**
 * electron-builder afterPack hook.
 *
 * electron-builder forcibly excludes any directory named node_modules from
 * copied resources (extraResources filters cannot override this). The bundled
 * dsh runtime however needs its full node_modules tree, so we copy it ourselves
 * after packing.
 *
 * Source of truth for the runtime layout lives in
 * packages/client-runtime/src/prepare-cli.ts (runtimes/pack).
 */
const fs = require('node:fs')
const path = require('node:path')

/** @param {import('app-builder-lib').AfterPackContext} context */
exports.default = async function afterPack(context) {
  // Verify the embedded plugin is present in every packaged app. Without it,
  // dsh fails while applying cordis:include and Electron later reports the
  // misleading ERR_CONNECTION_REFUSED for the local UI.
  const pluginEntry = path.join(context.appOutDir, 'resources', 'plugin-embedded-client', 'index.js')
  if (!fs.existsSync(pluginEntry)) {
    throw new Error('[afterPack] embedded-client plugin missing: ' + pluginEntry)
  }

  // Only needed for the "full" scenario; the thin config has no dsh-runtime dir.
  const dst = path.join(context.appOutDir, 'resources', 'dsh-runtime')
  if (!fs.existsSync(dst)) return

  const projectDir = context.projectDir ?? context.packager.projectDir
  const targetArch = String(context.arch) === 'arm64' ? 'arm64' : 'x64'
  const archSpecificSrc = path.resolve(projectDir, '..', '..', 'runtimes', 'pack-' + targetArch)
  const fallbackSrc = path.resolve(projectDir, '..', '..', 'runtimes', 'pack')
  const isWindows = context.electronPlatformName === 'win32' || process.platform === 'win32'
  const runtimeNode = isWindows ? 'node.exe' : path.join('bin', 'node')
  const src = fs.existsSync(path.join(archSpecificSrc, runtimeNode))
    ? archSpecificSrc
    : fallbackSrc
  const nodeBin = path.join(src, runtimeNode)

  if (!fs.existsSync(nodeBin)) {
    throw new Error(
      '[afterPack] bundled runtime missing at ' +
        src +
        '; expected ' +
        runtimeNode +
        '; run pnpm prepare:runtime first',
    )
  }

  console.log('  • afterPack: copying full dsh runtime ' + src + ' -> ' + dst)
  fs.rmSync(dst, { recursive: true, force: true })
  fs.cpSync(src, dst, { recursive: true })

  const binJs = path.join(dst, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!fs.existsSync(binJs)) {
    throw new Error('[afterPack] dsh bin.js not found after copy: ' + binJs)
  }
}
