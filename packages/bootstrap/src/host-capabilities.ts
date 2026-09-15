export type HarnessHostId =
  | 'tauri'
  | 'tauri-ios'
  | 'tauri-android'
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
    autoUpdate: true,
    tray: true,
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

/** Supported v0.2 host profiles. */
export const HOST_PROFILES = {
  tauri: TAURI_HOST_PROFILE,
  'tauri-ios': TAURI_IOS_HOST_PROFILE,
  'tauri-android': TAURI_ANDROID_HOST_PROFILE,
} as const

export function supportsRuntime(profile: HarnessHostProfile, mode: RuntimeAccessMode): boolean {
  return profile.capabilities.runtimes.includes(mode)
}
