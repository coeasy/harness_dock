import type { ClientCommandName, ClientCommandSource } from './client-command-bus.ts'
import type {
  RuntimeHealth,
  RuntimeProviderKind,
  RuntimeSession,
} from './runtime-provider.ts'
import type { UpdateSnapshot, UpdateTarget } from './update-state.ts'

export type NetworkState = 'online' | 'offline' | 'limited' | 'proxy-error' | 'dns-error' | 'tls-error'
export type ProxyMode =
  | 'system'
  | 'direct'
  | 'http'
  | 'https'
  | 'socks5'
  | 'proxy'
  | 'pac'
  | 'unknown'
export type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type RuntimeLifecycleState =
  | 'disconnected'
  | 'connecting'
  | 'ready'
  | 'degraded'
  | 'crashed'
  | 'restarting'
  | 'updating'
  | 'rolling-back'
  | 'stopping'
  | 'stopped'

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

export interface FileTransferProgress {
  transferredBytes: number
  totalBytes?: number
}

export interface DownloadFileInput {
  url: string
  destination?: string
  suggestedName?: string
  workspaceRoot?: string
  headers?: Readonly<Record<string, string>>
  expectedSha256?: string
  resume?: boolean
  signal?: AbortSignal
  onProgress?: (progress: FileTransferProgress) => void
}

export interface DownloadFileResult {
  path: string
  bytes: number
  sha256: string
  resumed: boolean
}

export interface UploadFileInput {
  sourcePath: string
  destinationUrl: string
  workspaceRoot?: string
  method?: 'POST' | 'PUT'
  headers?: Readonly<Record<string, string>>
  signal?: AbortSignal
  onProgress?: (progress: FileTransferProgress) => void
}

export interface UploadFileResult {
  statusCode: number
  bytes: number
}

export interface AppLifecycleService {
  focus(): Promise<void>
  quit(): Promise<void>
  relaunch(): Promise<void>
}

export interface RuntimeStatus {
  state: RuntimeLifecycleState
  provider: RuntimeProviderKind
  session?: RuntimeSession
  health?: RuntimeHealth
  updatedAt: string
}

export interface RuntimeService {
  status(): Promise<RuntimeStatus>
  connect(): Promise<RuntimeSession>
  health(): Promise<RuntimeHealth>
  restart(): Promise<RuntimeSession>
  stop(): Promise<void>
  disconnect(): Promise<void>
}

export interface FileService {
  pickFiles(options?: FilePickerOptions): Promise<readonly string[]>
  pickDirectory(options?: { title?: string }): Promise<string | null>
  saveFile(options?: SaveFileOptions): Promise<string | null>
  openPath(path: string, workspaceRoot?: string): Promise<void>
  revealPath(path: string, workspaceRoot?: string): Promise<void>
  downloadFile(input: DownloadFileInput): Promise<DownloadFileResult>
  uploadFile(input: UploadFileInput): Promise<UploadFileResult>
}

export interface CredentialService {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<readonly string[]>
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

export interface NetworkDiagnostic {
  target: string
  state: NetworkState
  reachable: boolean
  proxyMode: ProxyMode
  latencyMs?: number
  httpStatus?: number
  errorCode?: string
  checkedAt: string
}

export interface ProxyConfiguration {
  mode: 'system' | 'direct' | 'http' | 'https' | 'socks5' | 'pac'
  host?: string
  port?: number
  pacUrl?: string
  bypassRules?: readonly string[]
  /** CredentialService prefix containing `.username` and `.password`. */
  credentialKey?: string
}

export interface ClientLogEvent {
  level: ClientLogLevel
  component: string
  event: string
  message?: string
  data?: Record<string, unknown>
}

export interface ClientLogRecord extends ClientLogEvent {
  timestamp: string
}

export interface LogService {
  write(event: ClientLogEvent): Promise<void>
  recent(limit?: number): Promise<readonly ClientLogRecord[]>
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
  diagnose(target: string, timeoutMs?: number): Promise<NetworkDiagnostic>
  configureProxy(config: ProxyConfiguration): Promise<void>
}

export interface DeepLinkService {
  register(protocol: 'harnessdock'): Promise<void>
  subscribe(listener: (url: string) => void): () => void
}

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error'

export interface ClientNotification {
  title: string
  body?: string
  level?: NotificationLevel
  silent?: boolean
}

export interface NotificationService {
  notify(notification: ClientNotification): Promise<void>
}

export interface ClientWindowState {
  visible: boolean
  focused: boolean
  minimized: boolean
  maximized: boolean
  fullscreen: boolean
}

export interface WindowService {
  focusMain(): Promise<void>
  showMain(): Promise<void>
  hideMain(): Promise<void>
  state(): Promise<ClientWindowState>
}

export interface ClientPolicyRequest {
  action: ClientCommandName | string
  source?: ClientCommandSource
  capability?: string
  context?: Readonly<Record<string, unknown>>
}

export interface ClientPolicyDecision {
  allowed: boolean
  reason?: string
}

export class ClientPolicyDeniedError extends Error {
  constructor(
    readonly action: string,
    readonly reason = 'client policy denied this operation',
  ) {
    super(`Client policy denied ${action}: ${reason}`)
    this.name = 'ClientPolicyDeniedError'
  }
}

export interface PolicyService {
  evaluate(request: ClientPolicyRequest): Promise<ClientPolicyDecision>
  assertAllowed(request: ClientPolicyRequest): Promise<void>
}

/**
 * Compatibility aggregate used by the Electron v0.1 -> v0.2 migration.
 * New hosts should implement ClientServiceContract instead.
 */
export interface ClientServices {
  lifecycle: AppLifecycleService
  files: FileService
  credentials: CredentialService
  updates: UpdateService
  recovery: SessionRecoveryService
  diagnostics: DiagnosticsService
  network: NetworkService
  logs: LogService
  deepLinks: DeepLinkService
}

/** Full host-neutral service contract required by the v0.2 Stable architecture. */
export interface ClientServiceContract {
  app: AppLifecycleService
  runtime: RuntimeService
  files: FileService
  credentials: CredentialService
  updates: UpdateService
  recovery: SessionRecoveryService
  diagnostics: DiagnosticsService
  network: NetworkService
  logs: LogService
  notifications: NotificationService
  deepLinks: DeepLinkService
  windows: WindowService
  policy: PolicyService
}
