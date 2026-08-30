import { clipboard, ipcMain } from 'electron'
import { appState } from '../state.ts'

let registered = false

export function registerMobileIpc(): void {
  if (registered) return
  registered = true

  ipcMain.handle('mobile:get-status', () => {
    const gateway = appState.gateway
    if (!gateway) {
      return {
        enabled: false,
        publicUrl: process.env.HARNESSDOCK_GATEWAY_PUBLIC_URL?.trim() || null,
        devices: [],
      }
    }
    return {
      enabled: true,
      localUrl: gateway.localUrl,
      publicUrl: gateway.publicUrl,
      devices: gateway.listDevices(),
    }
  })

  ipcMain.handle('mobile:create-pairing', () => {
    const gateway = appState.gateway
    if (!gateway) return { ok: false, error: 'gateway-disabled' }
    return { ok: true, ticket: gateway.createPairingTicket() }
  })

  ipcMain.handle('mobile:revoke-device', (_event, deviceId: unknown) => {
    const gateway = appState.gateway
    if (!gateway) return { ok: false, error: 'gateway-disabled' }
    if (typeof deviceId !== 'string' || !/^[a-f0-9]{32}$/.test(deviceId)) {
      return { ok: false, error: 'invalid-device-id' }
    }
    return { ok: gateway.revokeDevice(deviceId) }
  })

  ipcMain.handle('mobile:revoke-all', () => {
    const gateway = appState.gateway
    if (!gateway) return { ok: false, error: 'gateway-disabled', count: 0 }
    return { ok: true, count: gateway.revokeAllDevices() }
  })

  ipcMain.handle('mobile:copy-text', (_event, value: unknown) => {
    if (typeof value !== 'string' || value.length > 2048) return { ok: false }
    clipboard.writeText(value)
    return { ok: true }
  })
}
