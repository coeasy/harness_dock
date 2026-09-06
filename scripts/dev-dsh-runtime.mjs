/**
 * dev-dsh 的运行时主体：启动 dsh web → 等待就绪 → 打印访问地址 → 保持运行。
 * Ctrl+C 或 SIGTERM 时优雅停止 dsh 主进程。
 *
 * 这个文件必须由 scripts/dev-dsh.mjs 以 `node --import tsx` 拉起（它 import 了
 * 工作区内的 .ts 源码）。依赖补齐放在启动器里做：`--import tsx` 会在本文件主体
 * 执行之前解析 tsx，node_modules 缺失时进程已经退出了，兜底逻辑来不及运行。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

const { DshRuntime } = await import('../packages/client-runtime/src/runtime.ts')
const { resolveRuntimeMode } = await import('../packages/client-runtime/src/process.ts')
const { readOriginFile } = await import('../packages/docs-sync/src/index.ts')

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
