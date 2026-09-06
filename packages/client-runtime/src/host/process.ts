import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rejectFloatingDistTag } from '@dsh/docs-sync'
import type { Killable, RuntimeMode } from '../types.ts'

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
  if (input.bundledAvailable) return 'bundled'
  return input.packaged ? 'download' : 'local'
}

/** OS-level liveness check that also treats EPERM as an existing process. */
export function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface ProcessTreeOptions {
  /** how many parent→child hops to walk */
  maxDepth?: number
  /** hard ceiling for each OS enumeration command */
  commandTimeoutMs?: number
  /** injectable execFile for tests */
  exec?: typeof execFileAsync
  /** injectable platform for cross-platform tests */
  platform?: NodeJS.Platform
}

/**
 * Enumerates descendant pids via one PowerShell CIM snapshot. This is the
 * supported Windows fallback when wmic is missing on current Windows images.
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
 * Enumerates a POSIX process subtree from one `ps` snapshot. A single snapshot
 * avoids a per-generation shell loop and, importantly, gives shutdown a list
 * of descendants it can still verify after the root exits and the OS reparents
 * those descendants.
 */
export async function collectProcessTreeViaPs(
  root: number,
  options?: ProcessTreeOptions,
): Promise<number[]> {
  const exec = options?.exec ?? execFileAsync
  const maxDepth = options?.maxDepth ?? 6
  const commandTimeoutMs = options?.commandTimeoutMs ?? PROCESS_TREE_COMMAND_TIMEOUT_MS
  const { stdout } = await exec('ps', ['-eo', 'pid=,ppid='], {
    windowsHide: true,
    timeout: commandTimeoutMs,
  })
  const children = new Map<number, number[]>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/)
    if (!match) continue
    const pid = Number(match[1])
    const parent = Number(match[2])
    if (pid <= 0 || parent < 0 || pid === root) continue
    const values = children.get(parent) ?? []
    values.push(pid)
    children.set(parent, values)
  }

  const found = new Set<number>()
  let frontier = [root]
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: number[] = []
    for (const parent of frontier) {
      for (const pid of children.get(parent) ?? []) {
        if (found.has(pid)) continue
        found.add(pid)
        next.push(pid)
      }
    }
    frontier = next
  }
  return [...found]
}

/**
 * Enumerates descendants using the native platform strategy. Windows tries
 * wmic first for compatibility and falls back to CIM; POSIX uses a `ps`
 * snapshot. Best-effort callers receive [] if enumeration is unavailable.
 */
export async function collectProcessTree(
  root: number,
  options?: ProcessTreeOptions,
): Promise<number[]> {
  const platform = options?.platform ?? process.platform
  if (platform !== 'win32') {
    return collectProcessTreeViaPs(root, options).catch(() => [])
  }

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
      return collectProcessTreeViaCim(root, { ...options, maxDepth, commandTimeoutMs, exec }).catch(
        () => [],
      )
    }
  }
  return [...known]
}

export interface ShutdownResult {
  /** true when the direct child AND every discovered descendant are gone */
  dead: boolean
  /** pids still alive after the bounded ladder */
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
    /** OS-level liveness check; required for subtree verification */
    isProcessAlive?: (pid: number) => boolean
    /** descendant enumeration; injectable for tests */
    collectTree?: (pid: number) => Promise<number[]>
    /** POSIX descendant signal seam; injectable for tests */
    killPid?: (pid: number, signal: NodeJS.Signals) => void
    /** force the Windows verification sweep even with mocked primitives */
    verify?: boolean
  },
): Promise<ShutdownResult> {
  if (!options.isAlive()) return { dead: true, survivors: [] }
  const platform = options.platform ?? process.platform
  const verify = options.verify ?? (!options.taskkill && !options.isProcessAlive)
  const alive = options.isProcessAlive ?? isProcessAlive
  const tree = options.collectTree ?? ((pid: number) => collectProcessTree(pid, { platform }))

  if (platform === 'win32' && child.pid) {
    const killTree = options.taskkill ?? defaultTaskkill
    const pid = child.pid
    let gracefulTreeRequested = false
    try {
      await killTree(pid, false)
      gracefulTreeRequested = true
    } catch {
      // Force step below also provides the direct-kill fallback.
    }
    if (gracefulTreeRequested && (await waitWhile(options.isAlive, options.termMs))) {
      return { dead: true, survivors: [] }
    }

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

    const survivorsAfter = await sweepWithVerification(pid, killTree, alive, tree)
    return { dead: survivorsAfter.length === 0, survivors: survivorsAfter }
  }

  // POSIX hosts used to signal only the direct child. dsh can own plugin or
  // helper descendants, which then survive if the root exits first. Snapshot
  // the subtree before TERM so those pids remain verifiable after reparenting.
  const rootPid = child.pid
  const descendants = new Set<number>(rootPid ? await tree(rootPid).catch(() => []) : [])
  const signalDescendant = options.killPid ?? defaultKillPid
  for (const pid of [...descendants].reverse()) {
    try {
      signalDescendant(pid, 'SIGTERM')
    } catch {
      // ESRCH/races are expected while the tree is already draining.
    }
  }
  child.kill('SIGTERM')

  const posixTreeAlive = () =>
    options.isAlive() || [...descendants].some((pid) => alive(pid))
  if (await waitWhile(posixTreeAlive, options.termMs)) {
    return { dead: true, survivors: [] }
  }

  // Capture children created during graceful shutdown while the root is still
  // addressable, then force-kill all known descendants before the root.
  if (rootPid && options.isAlive()) {
    for (const pid of await tree(rootPid).catch(() => [])) descendants.add(pid)
  }
  for (const pid of [...descendants].reverse()) {
    if (!alive(pid)) continue
    try {
      signalDescendant(pid, 'SIGKILL')
    } catch {
      // Verification below decides whether a failed signal matters.
    }
  }
  if (options.isAlive()) child.kill('SIGKILL')
  await waitWhile(posixTreeAlive, options.killMs)

  const survivors = [
    ...(rootPid && options.isAlive() ? [rootPid] : []),
    ...[...descendants].filter((pid) => alive(pid)),
  ]
  return { dead: survivors.length === 0, survivors: [...new Set(survivors)] }
}

/** Re-checks Windows OS liveness and force-kills whatever survived. */
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
  if (sysRoot) candidates.push(`${sysRoot}\\System32\\taskkill.exe`)
  for (const bin of candidates) {
    try {
      await execFileAsync(bin, args, { windowsHide: true })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new TaskkillUnavailable()
}

function defaultKillPid(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal)
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
