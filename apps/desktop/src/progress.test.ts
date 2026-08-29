import { describe, expect, it } from 'vitest'
import { BOOT_PROGRESS, mapRuntimeFetchProgress, MonotonicProgress } from './progress.ts'

describe('boot progress', () => {
  it('maps dependency download into a bounded boot phase', () => {
    expect(mapRuntimeFetchProgress(0)).toBe(12)
    expect(mapRuntimeFetchProgress(50)).toBe(47)
    expect(mapRuntimeFetchProgress(100)).toBe(82)
    expect(mapRuntimeFetchProgress(150)).toBe(82)
  })

  it('never moves backwards and reserves 100 for completion', () => {
    const progress = new MonotonicProgress()
    const values = [
      progress.advance(BOOT_PROGRESS.starting),
      progress.advance(BOOT_PROGRESS.resolving),
      progress.advance(mapRuntimeFetchProgress(96)),
      progress.advance(mapRuntimeFetchProgress(48)),
      progress.advance(BOOT_PROGRESS.downloadReady),
      progress.advance(BOOT_PROGRESS.runtimeReady),
      progress.advance(BOOT_PROGRESS.interfaceLoading),
    ]

    expect(values).toEqual([...values].sort((a, b) => a - b))
    expect(values.at(-1)).toBe(97)
    expect(progress.advance(100)).toBe(99)
    expect(progress.complete()).toBe(100)
  })

  it('can be reset between splash lifecycles', () => {
    const progress = new MonotonicProgress()
    progress.advance(88)
    expect(progress.reset()).toBe(0)
    expect(progress.current()).toBe(0)
  })
})
