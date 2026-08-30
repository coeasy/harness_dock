export type HarnessHostId =
  | 'electron'
  | 'tauri'
  | 'tauri-ios'
  | 'tauri-android'
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

/** Legacy v0.1 desktop baseline retained for compatibility, not the v0.2 release host. */
export const ELECTRON_HOST_PROFILE: HarnessHostProfile = {
  id: 'electron',
  productName: 'HarnessDock Legacy Electron',
  channel: 'lts',
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

/** v0.2 stable desktop host. Capability flags describe implemented Tauri features only. */
export const TAURI_HOST_PROFILE: HarnessHostProfile = {
  id: 'tauri',
  productName: 'HarnessDock',
  channel: 'stable',
  appId: 'com.harnessdock.client',
  capabilities: {
    runtimes: ['local', 'remote'],
    downloads: true,
    filePicker: true,
    clipboardPermission: true,
    nativeJsBridge: true,
    serviceWorkers: true,
    autoUpdate: false,
    tray: false,
    notifications: false,
    pushNotifications: false,
    deepLinks: false,
    secureCredentials: false,
    backgroundExecution: false,
  },
}

/** Mobile v0.2 hosts are remote-runtime-only and expose no unimplemented native services. */
export const TAURI_IOS_HOST_PROFILE: HarnessHostProfile = {
  id: 'tauri-ios',
  productName: 'HarnessDock',
  channel: 'stable',
  appId: 'com.harnessdock.client',
  capabilities: {
    runtimes: ['remote'],
    downloads: false,
    filePicker: true,
    clipboardPermission: true,
    nativeJsBridge: true,
    serviceWorkers: true,
    autoUpdate: false,
    tray: false,
    notifications: false,
    pushNotifications: false,
    deepLinks: false,
    secureCredentials: false,
    backgroundExecution: false,
  },
}

export const TAURI_ANDROID_HOST_PROFILE: HarnessHostProfile = {
  id: 'tauri-android',
  productName: 'HarnessDock',
  channel: 'stable',
  appId: 'com.harnessdock.client',
  capabilities: {
    runtimes: ['remote'],
    downloads: false,
    filePicker: true,
    clipboardPermission: true,
    nativeJsBridge: true,
    serviceWorkers: true,
    autoUpdate: false,
    tray: false,
    notifications: false,
    pushNotifications: false,
    deepLinks: false,
    secureCredentials: false,
    backgroundExecution: false,
  },
}

/** @deprecated Historical lease/profile compatibility only; no Perry app is built or released. */
export const PERRY_DESKTOP_HOST_PROFILE: HarnessHostProfile = {
  ...TAURI_HOST_PROFILE,
  id: 'perry-desktop',
  channel: 'experimental',
  productName: 'HarnessDock Legacy Perry',
  appId: 'com.dsh.client.perry.preview',
}

/** @deprecated Historical compatibility only. */
export const PERRY_IOS_HOST_PROFILE: HarnessHostProfile = {
  ...TAURI_IOS_HOST_PROFILE,
  id: 'perry-ios',
  channel: 'experimental',
  productName: 'HarnessDock Legacy Perry Mobile',
  appId: 'com.dsh.client.mobile.preview',
}

/** @deprecated Historical compatibility only. */
export const PERRY_ANDROID_HOST_PROFILE: HarnessHostProfile = {
  ...TAURI_ANDROID_HOST_PROFILE,
  id: 'perry-android',
  channel: 'experimental',
  productName: 'HarnessDock Legacy Perry Mobile',
  appId: 'com.dsh.client.mobile.preview',
}

/** Supported host profiles. Electron remains readable as the v0.1 LTS baseline. */
export const HOST_PROFILES = {
  electron: ELECTRON_HOST_PROFILE,
  tauri: TAURI_HOST_PROFILE,
  'tauri-ios': TAURI_IOS_HOST_PROFILE,
  'tauri-android': TAURI_ANDROID_HOST_PROFILE,
} as const

export function supportsRuntime(profile: HarnessHostProfile, mode: RuntimeAccessMode): boolean {
  return profile.capabilities.runtimes.includes(mode)
}
