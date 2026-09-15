import type { BrowserWindow, Tray } from 'electron'
import type { DshRuntime, RuntimeMode } from '@dsh/client-runtime'
import type { RuntimeLifecycleDiagnostics } from './diagnostics/diagnostics.ts'

/**
 * Mutable state shared between the boot flow, the shutdown ladder, and the
 * crash handlers. Kept in one place so modules can reference it without
 * circular imports.
 */
export const appState: {
  runtime: DshRuntime | undefined
  mainWindow: BrowserWindow | undefined
  dshPid: number | undefined
  tray: Tray | undefined
  quitting: boolean
  /** dsh version that actually started (after rollback, if any) — for diagnostics */
  dshVersion: string | undefined
  mode: RuntimeMode | undefined
  bundledAvailable: boolean | undefined
  /** Lifecycle facts shared by the boot path, shutdown ladder, and diagnostics. */
  lifecycle: RuntimeLifecycleDiagnostics
} = {
  runtime: undefined,
  mainWindow: undefined,
  dshPid: undefined,
  tray: undefined,
  quitting: false,
  dshVersion: undefined,
  mode: undefined,
  bundledAvailable: undefined,
  lifecycle: {
    startup_path: null,
    recovery_attempts: 0,
    last_recovery_action: null,
    shutdown_action: null,
  },
}
