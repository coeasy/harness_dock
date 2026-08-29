import { app } from 'electron'
import { appState } from './state.ts'
import { bootLog } from './boot-log.ts'
import { scheduleClosingHint } from './closing.ts'

/** Last-resort cleanup: force-kill the whole dsh tree by pid. */
export async function forceKillTree(pid: number | undefined): Promise<void> {
  if (!pid) return
  const sysRoot = process.env.SystemRoot ?? process.env.windir
  const candidates = ['taskkill']
  if (sysRoot) candidates.push(`${sysRoot}\\System32\\taskkill.exe`)
  for (const bin of candidates) {
    try {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      await promisify(execFile)(bin, ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
      })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
    }
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // already dead
  }
}

let quitting = false
let exiting = false

async function releaseRuntimeLease(): Promise<void> {
  const lease = appState.runtimeLease
  appState.runtimeLease = undefined
  if (!lease) return
  try {
    await lease.release()
  } catch (error) {
    await bootLog(`quit: runtime lease release failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Graceful-but-bounded shutdown: give the dsh process tree a chance to stop
 * cleanly, but never let a stuck descendant keep the client alive. The whole
 * sequence is capped at 15s; afterwards app.exit() runs unconditionally.
 */
export function beginShutdown(event?: Electron.Event): void {
  const runtime = appState.runtime
  if (!runtime) return
  if (quitting) return
  if (event) event.preventDefault()
  quitting = true
  appState.runtime = undefined

  scheduleClosingHint()

  const hardExit = (reason: string) => {
    if (exiting) return
    exiting = true
    void (async () => {
      await releaseRuntimeLease()
      await bootLog(`quit: ${reason}; calling app.exit(0)`)
      app.exit(0)
    })()
  }

  const watchdog = setTimeout(() => {
    void forceKillTree(appState.dshPid).finally(() => hardExit('shutdown watchdog expired (15s)'))
  }, 15_000)
  watchdog.unref()

  void runtime
    .stop()
    .then(async () => {
      clearTimeout(watchdog)
      const outcome = runtime.lastStopOutcome
      if (!outcome?.clean) {
        const survivors = outcome?.ladder?.survivors?.join(', ') ?? 'unknown'
        await bootLog(`quit: stop() left survivors (${survivors}); force-killing tree ${appState.dshPid}`)
        await forceKillTree(appState.dshPid)
        hardExit(`forced exit after taskkill (dsh survivors were: ${survivors})`)
        return
      }
      hardExit('clean exit')
    })
    .catch(async (error) => {
      clearTimeout(watchdog)
      await forceKillTree(appState.dshPid)
      hardExit(`stop() threw: ${error instanceof Error ? error.message : String(error)}`)
    })
}
