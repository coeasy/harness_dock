export type HarnessHostId =
  | 'electron'
  | 'tauri'
  | 'perry-desktop'
  | 'perry-ios'
  | 'perry-android'
  | 'vscode'

export type HarnessHostChannel = 'stable' | 'lts' | 'preview' | 'experimental'
export type RuntimeAccessMode = 'local' | 'remote'

export interface HarnessHostCapabilities {
  runtimes: readonly RuntimeAccessMode[]
  downloads: boolean
  filePicker: boolean
  clipboardPermission: boolean
  nativeJsBridge: boolean
  serviceWorkers: boolean
  autoUpdate: boolean
  tray: boolean
  notifications: boolean
  pushNotifications: boolean
  deepLinks: boolean
  secureCredentials: boolean
  backgroundExecution: boolean
}

export interface HarnessHostProfile {
  id: HarnessHostId
  productName: string
  channel: HarnessHostChannel
  appId: string
  capabilities: HarnessHostCapabilities
}

export const ELECTRON_HOST_PROFILE: HarnessHostProfile = {
  id: 'electron',
  productName: 'HarnessDock',
  channel: 'stable',
  appId: 'com.dsh.client',
  capabilities: {
    runtimes: ['local'],
    downloads: true,
    filePicker: true,
    clipboardPermission: true,
    nativeJsBridge: true,
    serviceWorkers: true,
    autoUpdate: true,
    tray: true,
    notifications: true,
    pushNotifications: false,
    deepLinks: true,
    secureCredentials: true,
    backgroundExecution: true,
  },
}

/**
 * Tauri is registered in the shared Host Contract before the native adapter is
 * promoted. Capability flags remain pessimistic until the v0.2 adapter and
 * parity tests prove each service. This prevents the UI from exposing native
 * actions that are only theoretically supported by Tauri.
 */
export const TAURI_HOST_PROFILE: HarnessHostProfile = {
  id: 'tauri',
  productName: 'HarnessDock Next-Gen Preview',
  channel: 'preview',
  appId: 'com.dsh.client.tauri.preview',
  capabilities: {
    runtimes: [],
    downloads: false,
    filePicker: false,
    clipboardPermission: false,
    nativeJsBridge: false,
    serviceWorkers: false,
    autoUpdate: false,
    tray: false,
    notifications: false,
    pushNotifications: false,
    deepLinks: false,
    secureCredentials: false,
    backgroundExecution: false,
  },
}

export const PERRY_DESKTOP_HOST_PROFILE: HarnessHostProfile = {
  id: 'perry-desktop',
  productName: 'HarnessDock Native Preview',
  channel: 'experimental',
  appId: 'com.dsh.client.perry.preview',
  capabilities: {
    runtimes: ['local'],
    downloads: false,
    filePicker: false,
    clipboardPermission: false,
    nativeJsBridge: false,
    serviceWorkers: false,
    autoUpdate: false,
    tray: false,
    notifications: false,
    pushNotifications: false,
    deepLinks: false,
    secureCredentials: false,
    backgroundExecution: true,
  },
}

/**
 * Mobile hosts are remote-runtime-only by design. They must never download or
 * execute the desktop dsh/Node runtime inside an App Store / Play package.
 */
export const PERRY_IOS_HOST_PROFILE: HarnessHostProfile = {
  id: 'perry-ios',
  productName: 'HarnessDock Mobile Preview',
  channel: 'preview',
  appId: 'com.dsh.client.mobile.preview',
  capabilities: {
    runtimes: ['remote'],
    downloads: false,
    filePicker: false,
    clipboardPermission: false,
    nativeJsBridge: false,
    serviceWorkers: false,
    autoUpdate: true,
    tray: false,
    notifications: true,
    pushNotifications: false,
    deepLinks: false,
    secureCredentials: false,
    backgroundExecution: false,
  },
}

export const PERRY_ANDROID_HOST_PROFILE: HarnessHostProfile = {
  id: 'perry-android',
  productName: 'HarnessDock Mobile Preview',
  channel: 'preview',
  appId: 'com.dsh.client.mobile.preview',
  capabilities: {
    runtimes: ['remote'],
    downloads: false,
    filePicker: false,
    clipboardPermission: false,
    nativeJsBridge: false,
    serviceWorkers: false,
    autoUpdate: true,
    tray: false,
    notifications: true,
    pushNotifications: false,
    deepLinks: false,
    secureCredentials: false,
    backgroundExecution: false,
  },
}

export const HOST_PROFILES = {
  electron: ELECTRON_HOST_PROFILE,
  tauri: TAURI_HOST_PROFILE,
  'perry-desktop': PERRY_DESKTOP_HOST_PROFILE,
  'perry-ios': PERRY_IOS_HOST_PROFILE,
  'perry-android': PERRY_ANDROID_HOST_PROFILE,
} as const

export function supportsRuntime(profile: HarnessHostProfile, mode: RuntimeAccessMode): boolean {
  return profile.capabilities.runtimes.includes(mode)
}
