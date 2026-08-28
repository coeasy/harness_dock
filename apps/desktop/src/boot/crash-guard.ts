import { app, dialog } from 'electron'
import { bootLog, getLogFile } from '../boot-log.ts'
import { fmt, t } from '../i18n.ts'
import { appState } from '../state.ts'
import { forceKillTree } from '../shutdown.ts'

/**
 * Main-process crash guard.
 *
 * An uncaught exception leaves the main process in an unknown state; without an
 * explicit exit the spawned dsh tree could survive as orphans. Guarded so a
 * crash inside the crash handler itself cannot loop forever.
 */
let crashing = false

export function installCrashGuard(): void {
  process.on('uncaughtException', (error) => {
    if (crashing) return
    crashing = true
    const message = error.stack ?? error.message
    void bootLog(`uncaughtException: ${message}`)
      .catch(() => undefined)
      .then(() => forceKillTree(appState.dshPid))
      .finally(() => {
        try {
          dialog.showErrorBox(
            t('crash.guard.title'),
            fmt(t('crash.guard.message'), {
              error: message.slice(0, 2000),
              logFile: getLogFile(),
            }),
          )
        } catch {
          // dialogs unavailable during teardown
        }
        app.exit(1)
      })
  })

  process.on('unhandledRejection', (reason) => {
    void bootLog(`unhandledRejection: ${String(reason)}`)
  })
}
