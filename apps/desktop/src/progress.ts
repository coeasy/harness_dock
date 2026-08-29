export const BOOT_PROGRESS = {
  starting: 4,
  resolving: 10,
  bundledReady: 78,
  downloadReady: 84,
  runtimeReady: 94,
  interfaceLoading: 97,
} as const

/** Map the downloader's 0-100 dependency progress into the boot flow. */
export function mapRuntimeFetchProgress(percent: number | null | undefined): number {
  const raw = typeof percent === 'number' && Number.isFinite(percent) ? percent : 0
  const clamped = Math.max(0, Math.min(100, raw))
  return Math.round(12 + clamped * 0.7)
}

/**
 * Prevent visual progress from moving backwards when runtime preparation is
 * retried, rolled back, or emits a new lower-level phase after a completed
 * dependency fetch. 100 is reserved for the final application-ready state.
 */
export class MonotonicProgress {
  private value = 0

  reset(): number {
    this.value = 0
    return this.value
  }

  advance(next: number): number {
    const finite = Number.isFinite(next) ? next : this.value
    const clamped = Math.max(0, Math.min(99, Math.round(finite)))
    this.value = Math.max(this.value, clamped)
    return this.value
  }

  complete(): number {
    this.value = 100
    return this.value
  }

  current(): number {
    return this.value
  }
}
