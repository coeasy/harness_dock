import { describe, expect, it } from 'vitest'
import { HostUpdateBusyError, HostUpdateStateMachine } from '../src/host-update-state.ts'

describe('host update state machine', () => {
  const now = () => new Date('2026-08-30T05:30:00.000Z')

  it('tracks check, download, verify and ready states using the shared contract', () => {
    const state = new HostUpdateStateMachine(now)
    expect(state.beginCheck('0.1.1')).toMatchObject({ phase: 'checking', currentVersion: '0.1.1' })
    expect(state.markAvailable('0.2.0')).toMatchObject({ phase: 'available', nextVersion: '0.2.0' })
    expect(state.markDownloadProgress(42.8)).toMatchObject({ phase: 'downloading', progress: 42 })
    expect(state.markDownloaded()).toMatchObject({ phase: 'ready', progress: 100 })
    expect(state.beginInstall()).toMatchObject({ phase: 'restart-required' })
  })

  it('returns to idle when the provider reports no update', () => {
    const state = new HostUpdateStateMachine(now)
    state.beginCheck('0.1.1')
    expect(state.markNoUpdate()).toMatchObject({
      phase: 'idle',
      currentVersion: '0.1.1',
      nextVersion: undefined,
    })
  })

  it('rejects a new check while an update is already staged', () => {
    const state = new HostUpdateStateMachine(now)
    state.beginCheck('0.1.1')
    state.markAvailable('0.2.0')
    state.markDownloaded()
    expect(() => state.beginCheck('0.1.1')).toThrow(HostUpdateBusyError)
  })

  it('records native updater failures without inventing an illegal transition', () => {
    const state = new HostUpdateStateMachine(now)
    state.beginCheck('0.1.1')
    expect(state.markFailure(new Error('feed unavailable'))).toMatchObject({
      phase: 'failed',
      error: 'feed unavailable',
    })
    expect(state.beginCheck('0.1.1')).toMatchObject({ phase: 'checking', error: undefined })
  })
})
