export class BootProgressTracker {
  private current = 4

  start(): number {
    return this.advance(4)
  }

  preparingRuntime(bundled: boolean): number {
    return this.advance(bundled ? 72 : 8)
  }

  resolving(done = 0, total?: number): number {
    if (total && total > 0) {
      const ratio = Math.max(0, Math.min(1, done / total))
      return this.advance(8 + Math.round(ratio * 10))
    }
    return this.advance(Math.min(18, 8 + Math.max(0, done)))
  }

  fetching(percent?: number): number {
    const raw = typeof percent === 'number' && Number.isFinite(percent) ? percent : 0
    const ratio = Math.max(0, Math.min(100, raw)) / 100
    return this.advance(18 + Math.round(ratio * 70))
  }

  runtimeInstalled(): number {
    return this.advance(90)
  }

  runtimeReady(): number {
    return this.advance(96)
  }

  loadingInterface(): number {
    return this.advance(98)
  }

  complete(): number {
    return this.advance(100)
  }

  private advance(candidate: number): number {
    this.current = Math.max(this.current, Math.max(0, Math.min(100, Math.round(candidate))))
    return this.current
  }
}
