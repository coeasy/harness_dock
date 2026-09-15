import os from 'node:os'
import path from 'node:path'

export type DesktopHostKind = 'tauri'
export type DesktopHostChannel = 'stable'

export interface DesktopHostCapabilities {
  downloads: boolean
  filePicker: boolean
  clipboardPermission: boolean
  nativeJsBridge: boolean
  serviceWorkers: boolean
  autoUpdate: boolean
  tray: boolean
  notifications: boolean
}

export interface DesktopHostDescriptor {
  kind: DesktopHostKind
  channel: DesktopHostChannel
  productName: string
  appId: string
  capabilities: DesktopHostCapabilities
}

export const TAURI_HOST: DesktopHostDescriptor = {
  kind: 'tauri',
  channel: 'stable',
  productName: 'HarnessDock',
  appId: 'com.harnessdock.client',
  capabilities: {
    downloads: true,
    filePicker: true,
    clipboardPermission: true,
    nativeJsBridge: true,
    serviceWorkers: true,
    autoUpdate: true,
    tray: true,
    notifications: false,
  },
}

export function defaultSharedStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HARNESSDOCK_STATE_DIR) return path.resolve(env.HARNESSDOCK_STATE_DIR)
  return path.join(os.homedir(), '.harnessdock')
}

/** Official Harness state remains in ~/.dsh; host-owned data is isolated by native shell. */
export function defaultHostUserDataDir(
  host: DesktopHostKind,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.HARNESSDOCK_HOST_DATA_DIR) return path.resolve(env.HARNESSDOCK_HOST_DATA_DIR)

  const leaf = 'Tauri'
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'HarnessDock', leaf)
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'HarnessDock', leaf)
  }
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'harnessdock', leaf.toLowerCase())
}
