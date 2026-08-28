import { describe, expect, it } from 'vitest'
import { HarnessSession } from '../src/controller.ts'

const ready = { url: 'http://127.0.0.1:43111', port: 43111, dshVersion: '0.1.1-rc.2' }

describe('HarnessSession', () => {
  it('reuses the running runtime across multiple panels (keep-alive off)', () => {
    const session = new HarnessSession(false)
    session.recordStarted(ready)
    session.panelOpened()
    session.panelOpened()

    expect(session.isRunning).toBe(true)
    expect(session.readyInfo?.url).toBe(ready.url)

    // closing one of two panels must NOT stop the shared runtime
    expect(session.panelClosed()).toBe(false)
    expect(session.isRunning).toBe(true)
    expect(session.snapshot().panelCount).toBe(1)

    // closing the last panel stops it
    expect(session.panelClosed()).toBe(true)
    expect(session.isRunning).toBe(false)
    expect(session.readyInfo).toBeUndefined()
  })

  it('keeps the runtime alive when keep-alive is on even after the last panel closes', () => {
    const session = new HarnessSession(true)
    session.recordStarted(ready)
    session.panelOpened()

    expect(session.panelClosed()).toBe(false)
    expect(session.isRunning).toBe(true)
    expect(session.readyInfo?.url).toBe(ready.url)
  })

  it('stopRequested reports a running runtime and clears it for a fresh start', () => {
    const session = new HarnessSession(false)
    session.recordStarted(ready)
    session.panelOpened()

    expect(session.stopRequested()).toBe(true)
    expect(session.isRunning).toBe(false)

    // a second explicit stop is a no-op
    expect(session.stopRequested()).toBe(false)
  })

  it('panelClosed on a non-running session never requests a stop', () => {
    const session = new HarnessSession(false)
    session.panelOpened()
    expect(session.panelClosed()).toBe(false)
    expect(session.panelClosed()).toBe(false) // extra close is clamped, still no stop
    expect(session.isRunning).toBe(false)
  })

  it('toggling keep-alive at runtime takes effect immediately', () => {
    const session = new HarnessSession(true)
    session.recordStarted(ready)
    session.panelOpened()
    session.setKeepAlive(false)

    expect(session.panelClosed()).toBe(true)
    expect(session.isRunning).toBe(false)
  })
})
