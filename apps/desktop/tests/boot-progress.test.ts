import { describe, expect, it } from 'vitest'
import { BootProgressTracker } from '../src/boot/progress.ts'

describe('BootProgressTracker', () => {
  it('never moves backwards when runtime phases change', () => {
    const progress = new BootProgressTracker()
    const values = [
      progress.start(),
      progress.preparingRuntime(false),
      progress.resolving(1),
      progress.resolving(8),
      progress.fetching(12),
      progress.fetching(76),
      progress.fetching(40),
      progress.runtimeInstalled(),
      progress.runtimeReady(),
      progress.loadingInterface(),
      progress.complete(),
    ]

    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]!)
    }
    expect(values.at(-1)).toBe(100)
  })

  it('keeps metadata resolution below the download range', () => {
    const progress = new BootProgressTracker()
    expect(progress.resolving(1)).toBeLessThanOrEqual(18)
    expect(progress.resolving(50)).toBe(18)
  })

  it('maps download completion below runtime and interface readiness', () => {
    const progress = new BootProgressTracker()
    expect(progress.fetching(0)).toBe(18)
    expect(progress.fetching(100)).toBe(88)
    expect(progress.runtimeInstalled()).toBe(90)
    expect(progress.runtimeReady()).toBe(96)
    expect(progress.loadingInterface()).toBe(98)
    expect(progress.complete()).toBe(100)
  })

  it('starts bundled runtime ahead without ever simulating a download rollback', () => {
    const progress = new BootProgressTracker()
    expect(progress.start()).toBe(4)
    expect(progress.preparingRuntime(true)).toBe(72)
    expect(progress.runtimeReady()).toBe(96)
  })
})
