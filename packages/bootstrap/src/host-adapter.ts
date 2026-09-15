import type { HarnessHostProfile, RuntimeAccessMode } from './host-capabilities.ts'
import type { RuntimeSession, RuntimeStatus } from './client-core.ts'

export type HarnessSurface = 'desktop' | 'mobile' | 'extension'

export interface RemoteGatewayPairInput {
  baseUrl: string
  code: string
  deviceName: string
}

export interface RemoteGatewayPairResult {
  connectUrl: string
  expiresAt: string
}

/**
 * Host-neutral contract shared by the Tauri desktop/mobile surfaces and the
 * editor extension. UI code must depend on this shape rather than on a native
 * IPC implementation.
 */
export interface HarnessHostAdapter {
  readonly profile: HarnessHostProfile
  readonly surface: HarnessSurface
  runtimeStatus(): Promise<RuntimeStatus>
  connectRuntime(mode: RuntimeAccessMode): Promise<RuntimeSession>
  disconnectRuntime(): Promise<void>
  pairRemoteGateway(input: RemoteGatewayPairInput): Promise<RemoteGatewayPairResult>
  navigate(url: string): Promise<void>
}
