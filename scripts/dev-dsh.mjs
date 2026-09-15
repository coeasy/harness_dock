#!/usr/bin/env node
/**
 * 只启动一个 dsh 主进程（不拉起桌面客户端），用于日常开发验证。
 *
 * 用法：
 *   pnpm dev:dsh            # 默认优先 bundled 运行时（runtimes/pack）
 *   DSH_RUNTIME=local pnpm dev:dsh   # 强制使用 PATH 上的 dsh
 *   DSH_RUNTIME=bundled pnpm dev:dsh # 强制使用 bundled 运行时
 *
 * 这个文件是纯 Node 启动器（不需要 tsx）：先补齐工作区依赖，再以
 * `node --import tsx` 拉起 dev-dsh-runtime.mjs 执行真正的启动流程。
 *
 * 依赖兜底必须放在这里而不是 runtime 文件里——`node --import tsx` 会在脚本主体
 * 执行之前解析 tsx，node_modules 缺失时进程已经以 ERR_MODULE_NOT_FOUND 退出，
 * runtime 文件里的兜底永远跑不到。这里承接了 R6 去重时删除的 dev-dsh.sh 行为。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const dependencyRoot = path.join(repoRoot, 'node_modules')
const runtimeScript = path.join(here, 'dev-dsh-runtime.mjs')

if (!existsSync(dependencyRoot)) {
  console.log('[dev-dsh] node_modules 缺失，正在执行 pnpm install ...')
  const result = runPnpm(['install'])
  if (!result) {
    console.error('[dev-dsh] 无法启动 pnpm，请先安装 pnpm（或运行 corepack enable）后重试。')
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`[dev-dsh] pnpm install 失败（exit ${result.status}）。`)
    process.exit(result.status)
  }
  if (!existsSync(dependencyRoot)) {
    console.error('[dev-dsh] pnpm install 完成但 node_modules 仍未出现，请检查 workspace 配置。')
    process.exit(1)
  }
}

const child = spawn(process.execPath, ['--import', 'tsx', runtimeScript], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
})

// The child shares the terminal, so Ctrl+C reaches both processes. Re-send the
// signal so the child's own SIGINT handler can stop the dsh runtime gracefully
// instead of being killed mid-request.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(signal, () => {
    if (child.exitCode === null) child.kill(signal)
  })
}

child.on('error', (error) => {
  console.error(`[dev-dsh] 无法启动运行时（${error.message}）。`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0))
})

/**
 * Runs pnpm while tolerating the launcher differences between hosts.
 *
 * `spawnSync('pnpm.cmd')` on Windows fails with EINVAL because Node refuses to
 * exec a .cmd file directly, and bare `spawnSync('pnpm')` fails with ENOENT
 * because the shell's PATHEXT expansion never happens. `shell: true` makes
 * cmd.exe do the resolution instead. POSIX shims are plain executables, so they
 * need no shell and leaving `shell` off avoids argument-quoting surprises.
 */
function runPnpm(args) {
  const candidates =
    process.platform === 'win32'
      ? [
          { command: 'pnpm', options: { shell: true } },
          { command: 'pnpm.cmd', options: { shell: true } },
        ]
      : [{ command: 'pnpm', options: {} }]

  let lastError = null
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
      ...candidate.options,
    })
    if (!result.error) return result
    lastError = result.error
  }
  console.error(`[dev-dsh] pnpm 启动失败: ${lastError?.message ?? lastError}`)
  return null
}
