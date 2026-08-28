/**
 * 只启动一个 dsh 主进程（不拉起 Electron 客户端），用于日常开发验证。
 *
 * 用法：
 *   pnpm dev:dsh            # 默认优先 bundled 运行时（runtimes/pack）
 *   DSH_RUNTIME=local pnpm dev:dsh   # 强制使用 PATH 上的 dsh
 *   DSH_RUNTIME=bundled pnpm dev:dsh # 强制使用 bundled 运行时
 *
 * 行为：启动 dsh web → 等待就绪 → 打印访问地址 → 保持运行；
 * Ctrl+C 或 SIGTERM 时优雅停止 dsh 主进程。
 */
import { DshRuntime } from '../packages/client-runtime/src/runtime.ts'
import { resolveRuntimeMode } from '../packages/client-runtime/src/process.ts'
import { readOriginFile } from '../packages/docs-sync/src/index.ts'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

const origin = await readOriginFile(path.join(repoRoot, 'packages', 'docs-sync', 'origin.json'))
const pluginPath = path.join(repoRoot, 'packages', 'plugin-embedded-client', 'lib', 'index.js')
const bundledRoot = path.join(repoRoot, 'runtimes', 'pack')

const mode = resolveRuntimeMode({
  env: process.env,
  packaged: false,
  bundledAvailable: await import('../packages/client-runtime/src/bundled.ts')
    .then((m) => m.inspectBundledRuntime(bundledRoot, process.platform) !== null)
    .catch(() => false),
})
console.log(`[dev-dsh] runtime mode = ${mode}`)

const runtime = new DshRuntime({
  origin,
  pluginPath,
  packaged: false,
  bundledRoot,
})

let readyInfo
try {
  readyInfo = await runtime.start()
} catch (error) {
  console.error('[dev-dsh] 启动失败:', error instanceof Error ? error.message : error)
  process.exit(1)
}

console.log(`[dev-dsh] dsh web 已就绪，浏览器访问: ${readyInfo.url}`)
console.log('[dev-dsh] 按 Ctrl+C 停止...')

async function shutdown() {
  await runtime.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
