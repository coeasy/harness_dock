import { describe, expect, it, vi } from 'vitest'
import {
  ClientCommandAbortedError,
  ClientCommandBus,
  ClientCommandHandlerConflictError,
  ClientCommandTimeoutError,
  ClientCommandValidationError,
  UnsupportedClientCommandError,
} from '../src/client-command-bus.ts'
import { REDACTED, redactDiagnostics } from '../src/diagnostics-redaction.ts'
import {
  InvalidHarnessDockDeepLinkError,
  deepLinkIntentToCommand,
  parseHarnessDockDeepLink,
} from '../src/deep-link.ts'
import {
  InvalidUpdateTransitionError,
  initialUpdateSnapshot,
  transitionUpdate,
} from '../src/update-state.ts'

describe('client command bus', () => {
  it('dispatches one command through the registered host-neutral handler', async () => {
    const bus = new ClientCommandBus()
    const handler = vi.fn((command) => ({ focused: command.payload }))
    bus.register('app.focus', handler)

    const result = await bus.dispatch<{ route: string }, { focused: { route: string } }>({
      name: 'app.focus',
      source: 'deep-link',
      payload: { route: '/chat/new' },
      issuedAt: '2026-08-30T00:00:00.000Z',
      id: 'cmd-1',
    })

    expect(result).toEqual({ focused: { route: '/chat/new' } })
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cmd-1', name: 'app.focus', source: 'deep-link' }),
    )
  })

  it('rejects ambiguous or unsupported command handlers', async () => {
    const bus = new ClientCommandBus()
    bus.register('update.check', () => undefined)
    expect(() => bus.register('update.check', () => undefined)).toThrow(ClientCommandHandlerConflictError)
    await expect(
      bus.dispatch({ name: 'runtime.restart', source: 'ui', payload: {} }),
    ).rejects.toBeInstanceOf(UnsupportedClientCommandError)
  })

  it('validates payloads before invoking privileged handlers', async () => {
    const bus = new ClientCommandBus()
    const handler = vi.fn(() => 'installed')
    bus.register('plugin.install', handler, {
      validate: (payload) => {
        const record = payload as Record<string, unknown>
        return typeof record?.pluginId === 'string' && record.pluginId.length > 0
      },
    })

    await expect(
      bus.dispatch({ name: 'plugin.install', source: 'deep-link', payload: {} }),
    ).rejects.toBeInstanceOf(ClientCommandValidationError)
    expect(handler).not.toHaveBeenCalled()

    await expect(
      bus.dispatch({
        name: 'plugin.install',
        source: 'deep-link',
        payload: { pluginId: 'demo.plugin' },
      }),
    ).resolves.toBe('installed')
  })

  it('supports cooperative cancellation and bounded command execution', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const bus = new ClientCommandBus()
    bus.register('runtime.stop', async () => new Promise<never>(() => undefined), { timeoutMs: 5 })

    await expect(
      bus.dispatch({ name: 'runtime.stop', source: 'ui', payload: {}, signal: aborted.signal }),
    ).rejects.toBeInstanceOf(ClientCommandAbortedError)

    await expect(
      bus.dispatch({ name: 'runtime.stop', source: 'ui', payload: {} }),
    ).rejects.toBeInstanceOf(ClientCommandTimeoutError)
  })
})

describe('HarnessDock deep links', () => {
  it('parses install and session routes into shared client commands', () => {
    const plugin = parseHarnessDockDeepLink('harnessdock://plugin/install?id=demo.plugin')
    expect(plugin).toEqual({ type: 'plugin-install', pluginId: 'demo.plugin' })
    expect(deepLinkIntentToCommand(plugin)).toEqual({
      name: 'plugin.install',
      payload: { pluginId: 'demo.plugin' },
    })

    expect(parseHarnessDockDeepLink('harnessdock://session/session-1')).toEqual({
      type: 'session-open',
      sessionId: 'session-1',
    })
  })

  it('rejects unknown protocols and missing sensitive pairing parameters', () => {
    expect(() => parseHarnessDockDeepLink('https://example.com/session/1')).toThrow(
      InvalidHarnessDockDeepLinkError,
    )
    expect(() => parseHarnessDockDeepLink('harnessdock://pair')).toThrow(
      InvalidHarnessDockDeepLinkError,
    )
  })
})

describe('update state machine', () => {
  it('allows the verified update lifecycle and rejects unsafe jumps', () => {
    const now = () => new Date('2026-08-30T00:00:00.000Z')
    let state = initialUpdateSnapshot('runtime', now)
    state = transitionUpdate(state, { phase: 'checking' }, now)
    state = transitionUpdate(state, { phase: 'available', nextVersion: '0.1.2' }, now)
    state = transitionUpdate(state, { phase: 'downloading', progress: 50 }, now)
    state = transitionUpdate(state, { phase: 'verifying', progress: 100 }, now)
    state = transitionUpdate(state, { phase: 'ready' }, now)
    expect(state.phase).toBe('ready')

    expect(() => transitionUpdate(state, { phase: 'succeeded' }, now)).toThrow(
      InvalidUpdateTransitionError,
    )
  })
})

describe('diagnostics redaction', () => {
  it('redacts nested secrets before diagnostics leave the client', () => {
    expect(
      redactDiagnostics({
        runtime: { version: '0.1.1' },
        authorization: 'Bearer secret',
        nested: { apiKey: 'sk-secret', cookie: 'session=secret', safe: 'visible' },
      }),
    ).toEqual({
      runtime: { version: '0.1.1' },
      authorization: REDACTED,
      nested: { apiKey: REDACTED, cookie: REDACTED, safe: 'visible' },
    })
  })
})
