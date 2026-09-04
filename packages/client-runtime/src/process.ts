import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rejectFloatingDistTag } from '@dsh/docs-sync'
import type { Killable, RuntimeMode } from './types.ts'

const execFileAsync = promisify(execFile)
const PROCESS_TREE_COMMAND_TIMEOUT_MS = 3_000

export function resolveRuntimeMode(input: {
  env: NodeJS.ProcessEnv
  packaged: boolean
  bundledAvailable?: boolean
}): RuntimeMode {
  if (input.env.DSH_RUNTIME_VERSION) {
    rejectFloatingDistTag(input.env.DSH_RUNTIME_VERSION)
  }
  const raw = input.env.DSH_RUNTIME
  if (raw === 'local' || raw === 'download' || raw === 'bundled') return raw
  // bundled 运行时可用时优先采用（无论 packaged 与否），
  // 使开发模式（Tauri 未打包 / 裸进程）无需 dsh 在 PATH 也能直接启动主进程
  if (input.bundledAvailable) return 'bundled'
  return input.packaged ? 'download' : 'local'
}

/**
 * OS-level liveness check for a pid. Unlike ChildProcess.exitCode this never
 * lies about processes that survived our own kill attempts.
 */
export function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to another user/session
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Options shared by the wmic and CIM process-tree enumerations.
 */
export interface ProcessTreeOptions {
  /** how many parent→child hops to walk (default 6, mirroring wmic loop) */
  maxDepth?: number
  /** hard ceiling for each OS enumeration command; prevents quit from hanging on CIM */
  commandTimeoutMs?: number
  /** injectable execFile for tests */
  exec?: typeof execFileAsync
}

/**
 * Enumerates descendant pids (children, grandchildren, …) of `root` in a single
 * PowerShell call via CIM (Get-CimInstance Win32_Process): all processes are
 * snapshotted once, then parent→child links are iterated up to `maxDepth`, with
 * one pid printed per line on stdout. Best-effort: throws on failure so callers
 * can fall back or degrade. The OS query is bounded because CIM can stall on
 * unhealthy Windows hosts and must never turn application shutdown into an
 * unbounded wait.
 */
export async function collectProcessTreeViaCim(
  root: number,
  options?: ProcessTreeOptions,
): Promise<number[]> {
  const exec = options?.exec ?? execFileAsync
  const maxDepth = options?.maxDepth ?? 6
  const commandTimeoutMs = options?.commandTimeoutMs ?? PROCESS_TREE_COMMAND_TIMEOUT_MS
  const script = [
    `$all = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ P=([int]$_.ProcessId); PP=([int]$_.ParentProcessId) } });`,
    `$roots = @(${root});`,
    `$res = New-Object System.Collections.Generic.List[int];`,
    `for ($i=0; $i -lt ${maxDepth} -and $roots.Count -gt 0; $i++) { $kids = @($all | Where-Object { $roots -contains $_.PP } | ForEach-Object { $_.P } | Sort-Object -Unique); foreach ($k in $kids) { $res.Add([int]$k) }; $roots = $kids };`,
    `$res | Sort-Object -Unique`,
  ].join(' ')
  const { stdout } = await exec('powershell', ['-NoProfile', '-Command', script], {
    windowsHide: true,
    timeout: commandTimeoutMs,
  })
  const pids = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map((line) => Number(line))
  return [...new Set(pids)].filter((pid) => pid > 0 && pid !== root)
}

/**
 * Enumerates descendant pids (children, grandchildren, …) of `root` via wmic,
 * falling back to the PowerShell CIM enumeration when wmic is unavailable
 * (it is deprecated and removed by default on Windows 11 24H2+).
 * Best-effort: returns [] when every enumeration path fails.
 */
export async function collectProcessTree(
  root: number,
  options?: ProcessTreeOptions,
): Promise<number[]> {
  const exec = options?.exec ?? execFileAsync
  const maxDepth = options?.maxDepth ?? 6
  const commandTimeoutMs = options?.commandTimeoutMs ?? PROCESS_TREE_COMMAND_TIMEOUT_MS
  const known = new Set<number>()
  let frontier = [root]
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const where = frontier.map((p) => `ParentProcessId=${p}`).join(' OR ')
    try {
      const { stdout } = await exec(
        'wmic',
        ['process', 'where', where, 'get', 'ProcessId', '/format:list'],
        { windowsHide: true, timeout: commandTimeoutMs },
      )
      const kids = [...stdout.matchAll(/ProcessId=(\d+)/g)]
        .map((m) => Number(m[1]))
        .filter((p) => p > 0 && p !== root && !known.has(p))
      for (const kid of kids) known.add(kid)
      frontier = kids
    } catch {
      // wmic failed (missing binary / broken output / permission): rebuild the
      // whole tree from root through the CIM enumeration instead of returning
      // a silently-empty (or partial) result and orphaning the dsh descendants.
      return collectProcessTreeViaCim(root, { maxDepth, commandTimeoutMs, exec }).catch(() => [])
    }
  }
  return [...known]
}

export interface ShutdownResult {
  /** true when the direct child AND all discovered descendants are gone */
  dead: boolean
  /** pids still alive after the ladder ran (empty when dead) */
  survivors: number[]
}

export async function shutdownLadder(
  child: Killable,
  options: {
    termMs: number
    killMs: number
    isAlive: () => boolean
    platform?: NodeJS.Platform
    taskkill?: (pid: number, force: boolean) => Promise<void>
    /** OS-level liveness check; required for the verification sweep */
    isProcessAlive?: (pid: number) => boolean
    /** descendant enumeration; required for the verification sweep */
    collectTree?: (pid: number) => Promise<number[]>
    /** force the verification sweep even with mocked taskkill/isAlive (tests) */
    verify?: boolean
  },
): Promise<ShutdownResult> {
  if (!options.isAlive()) return { dead: true, survivors: [] }
  const platform = options.platform ?? process.platform

  // The sweep needs real OS primitives. Mocked taskkill/isAlive manage their
  // own alive-state in tests, so verification is opt-in there.
  const verify = options.verify ?? (!options.taskkill && !options.isProcessAlive)
  const alive = options.isProcessAlive ?? isProcessAlive
  const tree = options.collectTree ?? ((pid: number) => collectProcessTree(pid))

  if (platform === 'win32' && child.pid) {
    const killTree = options.taskkill ?? defaultTaskkill
    const pid = child.pid

    // Windows console processes commonly reject non-forced taskkill. When the
    // command itself fails, waiting the full graceful window cannot make any
    // progress, so escalate immediately to the tree force-kill instead of
    // adding a deterministic multi-second delay to every Runtime shutdown.
    let gracefulTreeRequested = false
    try {
      await killTree(pid, false)
      gracefulTreeRequested = true
    } catch {
      // The force step below also provides the direct-kill fallback when
      // taskkill is missing entirely.
    }
    if (
      gracefulTreeRequested &&
      await waitWhile(options.isAlive, options.termMs)
    ) {
      return { dead: true, survivors: [] }
    }

    // 2) force-kill the whole tree (direct-kill fallback if unavailable).
    // A successful `taskkill /T /F` is already an OS-level tree guarantee; if
    // the root is reaped, avoid an expensive CIM sweep. Explicit `verify: true`
    // still forces the sweep for adversarial/mocked verification tests.
    let forcedTreeRequested = false
    try {
      await killTree(pid, true)
      forcedTreeRequested = true
    } catch {
      child.kill('SIGKILL')
    }
    const directDead = await waitWhile(options.isAlive, options.killMs)
    if (!verify) {
      const stillAlive = !directDead && options.isAlive()
      return { dead: !stillAlive, survivors: stillAlive ? [pid] : [] }
    }
    if (directDead && forcedTreeRequested && options.verify !== true) {
      return { dead: true, survivors: [] }
    }

    // 3) verify against the OS, sweeping survivors for up to 3 rounds. OS
    // enumeration itself is bounded by collectProcessTree so this path cannot
    // hold shutdown forever on a stalled Windows CIM provider.
    const survivorsAfter = await sweepWithVerification(pid, killTree, alive, tree)
    return { dead: survivorsAfter.length === 0, survivors: survivorsAfter }
  }

  child.kill('SIGTERM')
  if (await waitWhile(options.isAlive, options.termMs)) return { dead: true, survivors: [] }
  child.kill('SIGKILL')
  await waitWhile(options.isAlive, options.killMs)
  const stillAlive = options.isAlive()
  return { dead: !stillAlive, survivors: stillAlive && child.pid ? [child.pid] : [] }
}

/** Re-checks OS liveness and force-kills whatever survived; bounded retries. */
async function sweepWithVerification(
  pid: number,
  killTree: (pid: number, force: boolean) => Promise<void>,
  alive: (pid: number) => boolean,
  tree: (pid: number) => Promise<number[]>,
): Promise<number[]> {
  for (let round = 0; round < 3; round += 1) {
    await waitWhile(() => alive(pid), 400)
    const descendants = await tree(pid)
    const candidates = alive(pid) ? [pid, ...descendants] : descendants
    const survivors = candidates.filter((p) => alive(p))
    if (survivors.length === 0) return []
    for (const survivor of survivors) {
      await killTree(survivor, true)
    }
  }
  const descendants = await tree(pid)
  return [pid, ...descendants].filter((p) => alive(p))
}

class TaskkillUnavailable extends Error {
  constructor() {
    super('taskkill executable not found')
    this.name = 'TaskkillUnavailable'
  }
}

async function defaultTaskkill(pid: number, force: boolean): Promise<void> {
  const args = force ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T']
  const candidates = ['taskkill']
  const sysRoot = process.env.SystemRoot ?? process.env.windir
  if (sysRoot) {
    candidates.push(`${sysRoot}\\System32\\taskkill.exe`)
  }
  for (const bin of candidates) {
    try {
      await execFileAsync(bin, args, { windowsHide: true })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Propagate a real taskkill failure to the ladder. In particular,
        // non-forced taskkill commonly rejects console processes; swallowing
        // that error used to make shutdown wait termMs even though no graceful
        // termination had actually been requested.
        throw error
      }
      // ENOENT = binary not found on PATH -> try the next candidate
    }
  }
  // Neither taskkill nor %SystemRoot%\System32\taskkill.exe spawned
  // (broken PATH / stripped-down Windows): the ladder must fall back.
  throw new TaskkillUnavailable()
}

function waitWhile(isAlive: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now()
    const tick = () => {
      if (!isAlive()) {
        resolve(true)
        return
      }
      if (Date.now() - start >= ms) {
        resolve(false)
        return
      }
      setTimeout(tick, 10)
    }
    tick()
  })
}
