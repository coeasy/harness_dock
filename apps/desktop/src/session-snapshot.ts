import { appState } from './state.ts'
import { createElectronSessionRecoveryService } from './electron-services.ts'
import { recoveryRouteFromUrl } from './client-session-route.ts'

/** Persist the minimum navigation context before shutdown/update/relaunch. */
export async function captureCurrentSessionSnapshot(): Promise<void> {
  const window = appState.mainWindow
  if (!window || window.isDestroyed()) return
  const current = window.webContents.getURL()
  if (!current) return
  let origin: string
  try {
    origin = new URL(current).origin
  } catch {
    return
  }
  const route = recoveryRouteFromUrl(current, origin)
  if (!route) return
  await createElectronSessionRecoveryService().save({
    schemaVersion: 1,
    route,
    ...(appState.dshVersion ? { runtimeVersion: appState.dshVersion } : {}),
    savedAt: new Date().toISOString(),
  })
}
