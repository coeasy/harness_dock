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

  constructor(private readonly options: BootstrapOptions) {}

  get bootstrapResult(): BootstrapResult | undefined {
    return this.result
  }

  async connect(): Promise<RuntimeSession> {
    if (!this.result) this.result = await bootstrapRuntime(this.options)
    return {
      provider: 'local',
      appUrl: this.result.ready.url,
      connectedAt: new Date().toISOString(),
      dshVersion: this.result.ready.dshVersion,
      runtimePid: this.result.ready.pid,
      metadata: {
        mode: this.result.mode,
        bundledAvailable: this.result.bundledAvailable,
        rolledBack: this.result.rolledBack !== null,
      },
    }
  }

  async health(): Promise<RuntimeHealth> {
    if (!this.result) return { ok: false, provider: 'local', message: 'Local runtime is not connected.' }
    return {
      ok: true,
      provider: 'local',
      appUrl: this.result.ready.url,
      dshVersion: this.result.ready.dshVersion,
    }
  }

  async disconnect(): Promise<void> {
    const current = this.result
    this.result = undefined
    if (current) await current.runtime.stop()
  }
}
