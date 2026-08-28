import { app } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')

// bundle 脚本把 preload 编译到 dist/（.cjs：沙箱 preload 用 CJS，且包是 type:module）；
// main.js 被 esbuild 输出到 dist/，因此 import.meta.url 的目录就是 dist/。
export const preloadPath = path.join(here, 'preload.cjs')
// splash / diagnostics 窗口使用各自独立的 preload（同样经 bundle 脚本编译到 dist/）
export const splashPreloadPath = path.join(here, 'splash-preload.cjs')
export const diagnosticsPreloadPath = path.join(here, 'diagnostics-preload.cjs')

export function pluginPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'plugin-embedded-client', 'index.js')
  }
  return path.join(repoRoot, 'packages', 'plugin-embedded-client', 'lib', 'index.js')
}

export function bundledRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'dsh-runtime')
  }
  return path.join(repoRoot, 'runtimes', 'pack')
}

export function originPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'origin.json')
  }
  return path.join(repoRoot, 'packages', 'docs-sync', 'origin.json')
}

/** Brand icon for the window / taskbar (shipped as an extraResource). */
export function appIconPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icon-256.png')
  }
  return path.join(repoRoot, 'apps', 'desktop', 'build', 'icon-256.png')
}
