import type { BrowserWindow, Tray } from 'electron'
import type { DshRuntime, RuntimeMode } from '@dsh/client-runtime'
import type { RuntimeLeaseHandle } from '@dsh/bootstrap'
import type {
  RuntimeLifecycleState,
  UpdateService,
} from '@dsh/bootstrap/client-core'
import type { HarnessGatewayHandle } from '@dsh/bootstrap/gateway'

/**
 * Mutable state shared between boot, host adapters, recovery and shutdown.
 * Host-neutral APIs live in @dsh/bootstrap; this object contains only the
 * Electron process' current bindings to those APIs.
 */
export const appState: {
  runtime: DshRuntime | undefined
  runtimeLease: RuntimeLeaseHandle | undefined
  runtimeEndpoint: string | undefined
  runtimeState: RuntimeLifecycleState
  managedRuntimeVersion: string | undefined
  gateway: HarnessGatewayHandle | undefined
  hostUpdate: UpdateService | undefined
  updates: UpdateService | undefined
  mainWindow: BrowserWindow | undefined
  dshPid: number | undefined
  tray: Tray | undefined
  quitting: boolean
  leaseHeartbeat: NodeJS.Timeout | undefined
  runtimeSupervisorStop: (() => void) | undefined
  networkUnsubscribe: (() => void) | undefined
  /** dsh version that actually started (after rollback, if any) — for diagnostics */
  dshVersion: string | undefined
  mode: RuntimeMode | undefined
  bundledAvailable: boolean | undefined
} = {
  runtime: undefined,
  runtimeLease: undefined,
  runtimeEndpoint: undefined,
  runtimeState: 'disconnected',
  managedRuntimeVersion: undefined,
  gateway: undefined,
  hostUpdate: undefined,
  updates: undefined,
  mainWindow: undefined,
  dshPid: undefined,
  tray: undefined,
  quitting: false,
  leaseHeartbeat: undefined,
  runtimeSupervisorStop: undefined,
  networkUnsubscribe: undefined,
  dshVersion: undefined,
  mode: undefined,
  bundledAvailable: undefined,
}
