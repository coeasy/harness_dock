export type HarnessHostId =
  | 'electron'
  | 'tauri-desktop'
  | 'tauri-ios'
  | 'tauri-android'
  | 'perry-desktop'
  | 'perry-ios'
  | 'perry-android'
  | 'vscode'

export type RuntimeAccessMode = 'local' | 'remote'
export type HostChannel = 'stable' | 'next' | 'experimental'
export type HostReleaseRole = 'default' | 'compatibility' | 'experimental' | 'extension'

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
  channel: HostChannel
  releaseRole: HostReleaseRole
  appId: string
  capabilities: HarnessHostCapabilities
}

export const DEFAULT_DESKTOP_RELEASE_HOST: HarnessHostId = 'tauri-desktop'

export const ELECTRON_HOST_PROFILE: HarnessHostProfile = {
  id: 'electron',
  productName: 'HarnessDock',
  channel: 'stable',
  releaseRole: 'compatibility',
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
 * v0.2 default release candidate. Flags describe HarnessDock code that exists
 * today, not features Tauri could theoretically provide. Native-service flags
 * are promoted only together with their adapter + parity coverage.
 */
export const TAURI_DESKTOP_HOST_PROFILE: HarnessHostProfile = {
  id: 'tauri-desktop',
  productName: 'HarnessDock Next',
  channel: 'next',
  releaseRole: 'default',
  appId: 'com.dsh.client.tauri.next',
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

export const TAURI_IOS_HOST_PROFILE: HarnessHostProfile = {
  id: 'tauri-ios',
  productName: 'HarnessDock Mobile Next',
  channel: 'next',
  releaseRole: 'default',
  appId: 'com.dsh.client.mobile.next',
  capabilities: {
    runtimes: ['remote'],
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

export const TAURI_ANDROID_HOST_PROFILE: HarnessHostProfile = {
  ...TAURI_IOS_HOST_PROFILE,
  id: 'tauri-android',
}

export const PERRY_DESKTOP_HOST_PROFILE: HarnessHostProfile = {
  id: 'perry-desktop',
  productName: 'HarnessDock Native Experimental',
  channel: 'experimental',
  releaseRole: 'experimental',
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

/** Mobile hosts are remote-runtime-only by design. */
export const PERRY_IOS_HOST_PROFILE: HarnessHostProfile = {
  id: 'perry-ios',
  productName: 'HarnessDock Mobile Experimental',
  channel: 'experimental',
  releaseRole: 'experimental',
  appId: 'com.dsh.client.mobile.preview',
  capabilities: {
    runtimes: ['remote'],
    downloads: false,
    filePicker: false,
    clipboardPermission: false,
    nativeJsBridge: false,
    serviceWorkers: false,
    autoUpdate: false,
    tray: false,
    notifications: true,
    pushNotifications: false,
    deepLinks: false,
    secureCredentials: false,
    backgroundExecution: false,
  },
}

export const PERRY_ANDROID_HOST_PROFILE: HarnessHostProfile = {
  ...PERRY_IOS_HOST_PROFILE,
  id: 'perry-android',
}

export const VSCODE_HOST_PROFILE: HarnessHostProfile = {
  id: 'vscode',
  productName: 'HarnessDock for VS Code',
  channel: 'stable',
  releaseRole: 'extension',
  appId: 'harnessdock.vscode',
  capabilities: {
    runtimes: ['local'],
    downloads: false,
    filePicker: false,
    clipboardPermission: false,
    nativeJsBridge: true,
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

export const HOST_PROFILES: Readonly<Record<HarnessHostId, HarnessHostProfile>> = {
  electron: ELECTRON_HOST_PROFILE,
  'tauri-desktop': TAURI_DESKTOP_HOST_PROFILE,
  'tauri-ios': TAURI_IOS_HOST_PROFILE,
  'tauri-android': TAURI_ANDROID_HOST_PROFILE,
  'perry-desktop': PERRY_DESKTOP_HOST_PROFILE,
  'perry-ios': PERRY_IOS_HOST_PROFILE,
  'perry-android': PERRY_ANDROID_HOST_PROFILE,
  vscode: VSCODE_HOST_PROFILE,
}

export function supportsRuntime(profile: HarnessHostProfile, mode: RuntimeAccessMode): boolean {
  return profile.capabilities.runtimes.includes(mode)
}

export function isDefaultReleaseHost(profile: HarnessHostProfile): boolean {
  return profile.releaseRole === 'default'
}
