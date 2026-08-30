import os from 'node:os'
import path from 'node:path'

/**
 * Desktop shell implementation. This compatibility type deliberately stays
 * smaller than HarnessHostId because mobile and IDE hosts never own a desktop
 * dsh process lease.
 */
export type DesktopHostKind = 'electron' | 'tauri' | 'perry'
export type DesktopHostChannel = 'stable' | 'next' | 'experimental'

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
 * Tauri is the v0.2 Next-Gen default-release candidate. Capability flags are
 * intentionally implementation-based, not framework-potential-based: a flag
 * becomes true only after the HarnessDock adapter and parity test exist.
 */
export const TAURI_HOST: DesktopHostDescriptor = {
  kind: 'tauri',
  channel: 'next',
  productName: 'HarnessDock Next',
  appId: 'com.dsh.client.tauri.next',
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

/**
 * Perry stays Experimental while its embedded WebView intentionally omits a
 * general native<->JS RPC bridge and several browser-shell capabilities.
 */
export const PERRY_HOST: DesktopHostDescriptor = {
  kind: 'perry',
  channel: 'experimental',
  productName: 'HarnessDock Native Experimental',
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
 * Host-owned browser/shell state is isolated so Electron LTS, Tauri Next and
 * Perry Experimental can be installed side-by-side. Official Harness state in
 * ~/.dsh remains shared and is intentionally not managed here.
 */
export function defaultHostUserDataDir(
  host: DesktopHostKind,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.HARNESSDOCK_HOST_DATA_DIR) return path.resolve(env.HARNESSDOCK_HOST_DATA_DIR)

  const windowsMacLeaf: Record<DesktopHostKind, string> = {
    electron: 'Electron',
    tauri: 'TauriNextGen',
    perry: 'PerryExperimental',
  }
  const linuxLeaf: Record<DesktopHostKind, string> = {
    electron: 'electron',
    tauri: 'tauri-nextgen',
    perry: 'perry-experimental',
  }

  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'HarnessDock', windowsMacLeaf[host])
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'HarnessDock', windowsMacLeaf[host])
  }
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'harnessdock', linuxLeaf[host])
}
