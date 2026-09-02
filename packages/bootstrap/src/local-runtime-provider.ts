import { openWebUiSession, probeWebUiSession, type WebUiSession } from '@dsh/client-runtime'
import { bootstrapRuntime, type BootstrapOptions, type BootstrapResult } from './runtime.ts'
import type { RuntimeHealth, RuntimeProvider, RuntimeSession } from './runtime-provider.ts'

/**
 * Adapter around the existing desktop bootstrap flow. Keeping this wrapper in
 * the shared layer lets hosts migrate to RuntimeProvider incrementally without
 * changing the proven download/rollback/runtime implementation underneath.
 */
export class LocalRuntimeProvider implements RuntimeProvider {
  readonly kind = 'local' as const
  private result: BootstrapResult | undefined
  private webSession: WebUiSession | undefined
  private connectPromise: Promise<RuntimeSession> | undefined
  private disconnectPromise: Promise<void> | undefined
  private disconnectRequested = false

  constructor(private readonly options: BootstrapOptions) {}

  get bootstrapResult(): BootstrapResult | undefined {
    return this.result
  }

  async connect(): Promise<RuntimeSession> {
    if (this.connectPromise) return this.connectPromise
    const operation = (async (): Promise<RuntimeSession> => {
      if (this.disconnectPromise) await this.disconnectPromise
      this.disconnectRequested = false

      if (!this.result) {
        const bootstrapped = await bootstrapRuntime(this.options)
        if (this.disconnectRequested) {
          await bootstrapped.runtime.stop().catch(() => undefined)
          throw new Error('Local runtime connection cancelled by disconnect request.')
        }
        this.result = bootstrapped
      }
      if (!this.webSession) {
        const current = this.result
        const authenticated = await openWebUiSession(current.ready.url, { timeoutMs: 5_000 })
        if (!authenticated || this.disconnectRequested) {
          this.result = undefined
          this.webSession = undefined
          await current.runtime.stop().catch(() => undefined)
          if (this.disconnectRequested) {
            throw new Error('Local runtime connection cancelled by disconnect request.')
          }
          throw new Error('Local dsh Web UI did not establish an authenticated browser session.')
        }
        this.webSession = authenticated
      }
      const current = this.result
      const session = this.webSession
      if (!current || !session || this.disconnectRequested) {
        throw new Error('Local runtime connection cancelled by disconnect request.')
      }
      const recovery = current.runtime.pluginRecoveryState
      return {
        provider: 'local',
        appUrl: session.url,
        connectedAt: new Date().toISOString(),
        dshVersion: current.ready.dshVersion,
        runtimePid: current.ready.pid,
        upstream: {
          url: session.url,
          ...(session.cookie ? { cookie: session.cookie } : {}),
        },
        metadata: {
          mode: current.mode,
          bundledAvailable: current.bundledAvailable,
          rolledBack: current.rolledBack !== null,
          pluginRecovery: recovery.active,
          pluginRecoverySource: recovery.source,
          isolatedPluginCount: recovery.isolatedPlugins.length,
          suspectedPluginCount: recovery.suspectedPlugins.length,
        },
      }
    })()
    this.connectPromise = operation
    try {
      return await operation
    } finally {
      if (this.connectPromise === operation) this.connectPromise = undefined
    }
  }

  async health(): Promise<RuntimeHealth> {
    if (!this.result || !this.webSession) {
      return { ok: false, provider: 'local', message: 'Local runtime is not connected.' }
    }
    const ok = await probeWebUiSession(this.webSession, { timeoutMs: 2_000 })
    return {
      ok,
      provider: 'local',
      appUrl: this.webSession.url,
      dshVersion: this.result.ready.dshVersion,
      ...(!ok ? { message: 'Authenticated local dsh Web UI health probe failed.' } : {}),
    }
  }

  async disconnect(): Promise<void> {
    if (this.disconnectPromise) return this.disconnectPromise
    this.disconnectRequested = true
    const connecting = this.connectPromise
    const operation = (async (): Promise<void> => {
      await connecting?.catch(() => undefined)
      const current = this.result
      this.result = undefined
      this.webSession = undefined
      if (current) await current.runtime.stop()
    })()
    this.disconnectPromise = operation
    try {
      await operation
    } finally {
      if (this.disconnectPromise === operation) this.disconnectPromise = undefined
    }
  }
}
