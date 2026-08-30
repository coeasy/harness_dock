import {
  canTransitionUpdate,
  initialUpdateSnapshot,
  transitionUpdate,
  type UpdatePhase,
  type UpdateSnapshot,
} from '@dsh/bootstrap/client-core'

const BUSY_PHASES = new Set<UpdatePhase>([
  'checking',
  'downloading',
  'verifying',
  'ready',
  'stopping-runtime',
  'installing',
  'restart-required',
  'restarting',
  'rolling-back',
])

export class HostUpdateBusyError extends Error {
  constructor(readonly phase: UpdatePhase) {
    super(`Host update operation is already active (${phase})`)
    this.name = 'HostUpdateBusyError'
  }
}

/**
 * Small pure state holder around the strict shared update transition table.
 * Electron/Tauri drivers feed native updater events into this object; UI and
 * commands observe the same host-neutral UpdateSnapshot contract.
 */
export class HostUpdateStateMachine {
  private snapshot: UpdateSnapshot

  constructor(now: () => Date = () => new Date()) {
    this.now = now
    this.snapshot = initialUpdateSnapshot('host', now)
  }

  private readonly now: () => Date

  state(): UpdateSnapshot {
    return { ...this.snapshot }
  }

  beginCheck(currentVersion: string): UpdateSnapshot {
    if (BUSY_PHASES.has(this.snapshot.phase)) {
      if (this.snapshot.phase === 'checking') return this.state()
      throw new HostUpdateBusyError(this.snapshot.phase)
    }
    this.snapshot = transitionUpdate(
      this.snapshot,
      {
        phase: 'checking',
        currentVersion,
        nextVersion: undefined,
        progress: undefined,
        error: undefined,
      },
      this.now,
    )
    return this.state()
  }

  markAvailable(nextVersion: string): UpdateSnapshot {
    if (this.snapshot.phase === 'available') {
      return this.patch({ nextVersion })
    }
    this.advance('available', { nextVersion, error: undefined })
    return this.state()
  }

  markNoUpdate(): UpdateSnapshot {
    if (this.snapshot.phase !== 'checking') return this.state()
    this.advance('idle', { nextVersion: undefined, progress: undefined, error: undefined })
    return this.state()
  }

  markDownloadStarted(): UpdateSnapshot {
    if (this.snapshot.phase === 'downloading') return this.state()
    this.advance('downloading', { progress: 0 })
    return this.state()
  }

  markDownloadProgress(progress: number): UpdateSnapshot {
    if (this.snapshot.phase === 'available') this.markDownloadStarted()
    if (this.snapshot.phase !== 'downloading') return this.state()
    const bounded = Math.max(0, Math.min(100, Math.floor(progress)))
    return this.patch({ progress: bounded })
  }

  markDownloaded(): UpdateSnapshot {
    if (this.snapshot.phase === 'available') this.markDownloadStarted()
    if (this.snapshot.phase === 'downloading') this.advance('verifying', { progress: 100 })
    if (this.snapshot.phase === 'verifying') this.advance('ready', { progress: 100 })
    return this.state()
  }

  beginInstall(): UpdateSnapshot {
    this.advance('installing')
    this.advance('restart-required')
    return this.state()
  }

  markFailure(error: unknown): UpdateSnapshot {
    const message = error instanceof Error ? error.message : String(error)
    if (canTransitionUpdate(this.snapshot.phase, 'failed')) {
      this.advance('failed', { error: message })
    } else {
      this.patch({ error: message })
    }
    return this.state()
  }

  private advance(
    phase: UpdatePhase,
    patch: Omit<Partial<UpdateSnapshot>, 'target' | 'phase'> = {},
  ): void {
    this.snapshot = transitionUpdate(this.snapshot, { ...patch, phase }, this.now)
  }

  private patch(patch: Omit<Partial<UpdateSnapshot>, 'target' | 'phase'>): UpdateSnapshot {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      target: 'host',
      updatedAt: this.now().toISOString(),
    }
    return this.state()
  }
}
