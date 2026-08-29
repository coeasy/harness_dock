import os from 'node:os'
import path from 'node:path'

export type DesktopHostKind = 'electron' | 'perry'
export type DesktopHostChannel = 'stable' | 'preview'

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

export const ELECTRON_HOST: DesktopHostDescriptor = {
  kind: 'electron',
  channel: 'stable',
  productName: 'HarnessDock',
  appId: 'com.dsh.client',
  capabilities: {
    downloads: true,
    filePicker: true,
    clipboardPermission: true,
    nativeJsBridge: true,
    serviceWorkers: true,
    autoUpdate: true,
    tray: true,
    notifications: true,
  },
}

/**
 * Perry is intentionally a Preview host while Perry WebView keeps file
 * downloads, service workers and a general native<->JS RPC bridge out of scope.
 * Keep these capability flags pessimistic until parity tests prove otherwise.
 */
export const PERRY_HOST: DesktopHostDescriptor = {
  kind: 'perry',
  channel: 'preview',
  productName: 'HarnessDock Native Preview',
  appId: 'com.dsh.client.perry.preview',
  capabilities: {
    downloads: false,
    filePicker: false,
    clipboardPermission: false,
    nativeJsBridge: false,
    serviceWorkers: false,
    autoUpdate: false,
    tray: false,
    notifications: false,
  },
}

export function defaultSharedStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HARNESSDOCK_STATE_DIR) return path.resolve(env.HARNESSDOCK_STATE_DIR)
  return path.join(os.homedir(), '.harnessdock')
}

/**
 * Host-owned data must not collide during the Electron -> Perry transition.
 * Official Harness state remains in ~/.dsh and is intentionally not handled
 * here.
 */
export function defaultHostUserDataDir(
  host: DesktopHostKind,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.HARNESSDOCK_HOST_DATA_DIR) return path.resolve(env.HARNESSDOCK_HOST_DATA_DIR)

  const leaf = host === 'electron' ? 'Electron' : 'PerryPreview'
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
