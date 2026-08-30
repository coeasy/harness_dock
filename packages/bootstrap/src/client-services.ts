import type { UpdateSnapshot, UpdateTarget } from './update-state.ts'

export type NetworkState = 'online' | 'offline' | 'limited' | 'proxy-error' | 'dns-error' | 'tls-error'

export interface FilePickerOptions {
  multiple?: boolean
  title?: string
  filters?: ReadonlyArray<{ name: string; extensions: readonly string[] }>
}

export interface SaveFileOptions {
  title?: string
  suggestedName?: string
  filters?: ReadonlyArray<{ name: string; extensions: readonly string[] }>
}

export interface AppLifecycleService {
  focus(): Promise<void>
  quit(): Promise<void>
  relaunch(): Promise<void>
}

export interface FileService {
  pickFiles(options?: FilePickerOptions): Promise<readonly string[]>
  pickDirectory(options?: { title?: string }): Promise<string | null>
  saveFile(options?: SaveFileOptions): Promise<string | null>
  revealPath(path: string): Promise<void>
}

export interface CredentialService {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export interface HostUpdateInfo {
  target: UpdateTarget
  currentVersion: string
  nextVersion: string
  mandatory?: boolean
  notes?: string
}

export interface UpdateService {
  state(target: UpdateTarget): Promise<UpdateSnapshot>
  check(target: UpdateTarget): Promise<HostUpdateInfo | null>
  download(target: UpdateTarget): Promise<void>
  install(target: UpdateTarget): Promise<void>
  rollback(target: UpdateTarget): Promise<void>
}

export interface ClientSessionSnapshot {
  schemaVersion: 1
  route?: string
  sessionId?: string
  workspaceId?: string
  runtimeVersion?: string
  savedAt: string
}

export interface SessionRecoveryService {
  save(snapshot: ClientSessionSnapshot): Promise<void>
  load(): Promise<ClientSessionSnapshot | null>
  clear(): Promise<void>
}

export interface DiagnosticsSnapshot {
  generatedAt: string
  host: string
  hostVersion?: string
  runtimeVersion?: string
  runtimePid?: number
  platform?: string
  arch?: string
  networkState?: NetworkState
  data: Record<string, unknown>
}

export interface DiagnosticsService {
  collect(): Promise<DiagnosticsSnapshot>
  exportBundle(destination?: string): Promise<string>
}

export interface NetworkService {
  state(): Promise<NetworkState>
  subscribe(listener: (state: NetworkState) => void): () => void
}

export interface DeepLinkService {
  register(protocol: 'harnessdock'): Promise<void>
  subscribe(listener: (url: string) => void): () => void
}

export interface ClientServices {
  lifecycle: AppLifecycleService
  files: FileService
  credentials: CredentialService
  updates: UpdateService
  recovery: SessionRecoveryService
  diagnostics: DiagnosticsService
  network: NetworkService
  deepLinks: DeepLinkService
}
