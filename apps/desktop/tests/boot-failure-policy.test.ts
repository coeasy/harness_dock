import { describe, expect, it } from 'vitest'
import { classifyBootFailure } from '../src/boot/boot-failure-policy.ts'

describe('boot failure containment policy', () => {
  it('treats a plugin/runtime startup failure as host-degraded instead of app-fatal', () => {
    expect(classifyBootFailure({ runtimeStartAttempted: true, runtimeConnected: false }))
      .toBe('degraded-runtime')
  })

  it('keeps failures outside the managed Runtime boundary host-fatal', () => {
    expect(classifyBootFailure({ runtimeStartAttempted: false, runtimeConnected: false }))
      .toBe('fatal-host')
    expect(classifyBootFailure({ runtimeStartAttempted: true, runtimeConnected: true }))
      .toBe('fatal-host')
  })
})
