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

  constructor(private readonly options: BootstrapOptions) {}

  get bootstrapResult(): BootstrapResult | undefined {
    return this.result
  }

  async connect(): Promise<RuntimeSession> {
    if (!this.result) this.result = await bootstrapRuntime(this.options)
    if (!this.webSession) {
      const authenticated = await openWebUiSession(this.result.ready.url, { timeoutMs: 5_000 })
      if (!authenticated) {
        const failed = this.result
        this.result = undefined
        await failed.runtime.stop().catch(() => undefined)
        throw new Error('Local dsh Web UI did not establish an authenticated browser session.')
      }
      this.webSession = authenticated
    }
    return {
      provider: 'local',
      appUrl: this.webSession.url,
      connectedAt: new Date().toISOString(),
      dshVersion: this.result.ready.dshVersion,
      runtimePid: this.result.ready.pid,
      upstream: {
        url: this.webSession.url,
        ...(this.webSession.cookie ? { cookie: this.webSession.cookie } : {}),
      },
      metadata: {
        mode: this.result.mode,
        bundledAvailable: this.result.bundledAvailable,
        rolledBack: this.result.rolledBack !== null,
      },
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
    const current = this.result
    this.result = undefined
    this.webSession = undefined
    if (current) await current.runtime.stop()
  }
}
