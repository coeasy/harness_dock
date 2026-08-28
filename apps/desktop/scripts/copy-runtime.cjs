/**
 * electron-builder afterPack hook.
 *
 * electron-builder forcibly excludes any directory named `node_modules` from
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
  // Only needed for the "full" scenario; the thin config has no dsh-runtime dir.
  const dst = path.join(context.appOutDir, 'resources', 'dsh-runtime')
  if (!fs.existsSync(dst)) return

  const projectDir = context.projectDir ?? context.packager.projectDir
  const src = path.resolve(projectDir, '..', '..', 'runtimes', 'pack')
  if (!fs.existsSync(path.join(src, 'node.exe'))) {
    throw new Error(`[afterPack] bundled runtime missing at ${src}; run \`pnpm prepare:runtime\` first`)
  }

  console.log(`  • afterPack: copying full dsh runtime ${src} -> ${dst}`)
  fs.rmSync(dst, { recursive: true, force: true })
  fs.cpSync(src, dst, { recursive: true })

  const binJs = path.join(dst, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!fs.existsSync(binJs)) {
    throw new Error(`[afterPack] dsh bin.js not found after copy: ${binJs}`)
  }
}
