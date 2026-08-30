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
      name: 'app.focus', source: 'deep-link', payload: { route: '/chat/new' },
      issuedAt: '2026-08-30T00:00:00.000Z', id: 'cmd-1',
    })
    expect(result).toEqual({ focused: { route: '/chat/new' } })
  })

  it('rejects ambiguous or unsupported command handlers', async () => {
    const bus = new ClientCommandBus()
    bus.register('update.check', () => undefined)
    expect(() => bus.register('update.check', () => undefined)).toThrow(ClientCommandHandlerConflictError)
    await expect(bus.dispatch({ name: 'runtime.restart', source: 'ui', payload: {} }))
      .rejects.toBeInstanceOf(UnsupportedClientCommandError)
  })

  it('validates payloads and propagates cancellation/timeouts', async () => {
    const bus = new ClientCommandBus()
    bus.register('session.open', async (command) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return command.payload
    }, {
      validate: (payload) => Boolean(payload && typeof payload === 'object' && 'sessionId' in payload),
      timeoutMs: 10,
    })
    await expect(bus.dispatch({ name: 'session.open', source: 'ui', payload: {} }))
      .rejects.toBeInstanceOf(ClientCommandValidationError)
    await expect(bus.dispatch({ name: 'session.open', source: 'ui', payload: { sessionId: 's1' } }))
      .rejects.toBeInstanceOf(ClientCommandTimeoutError)

    const controller = new AbortController()
    controller.abort()
    await expect(bus.dispatch({
      name: 'session.open', source: 'ui', payload: { sessionId: 's1' }, signal: controller.signal,
    })).rejects.toBeInstanceOf(ClientCommandAbortedError)
  })
})

describe('HarnessDock deep links', () => {
  it('parses install, session and workspace-id routes into shared client commands', () => {
    const plugin = parseHarnessDockDeepLink('harnessdock://plugin/install?id=demo.plugin')
    expect(plugin).toEqual({ type: 'plugin-install', pluginId: 'demo.plugin' })
    expect(deepLinkIntentToCommand(plugin)).toEqual({ name: 'plugin.install', payload: { pluginId: 'demo.plugin' } })
    expect(parseHarnessDockDeepLink('harnessdock://session/session-1')).toEqual({ type: 'session-open', sessionId: 'session-1' })
    expect(parseHarnessDockDeepLink('harnessdock://workspace/workspace-1')).toEqual({
      type: 'workspace-open', workspaceId: 'workspace-1',
    })
  })

  it('rejects filesystem workspace paths from deep links', () => {
    expect(() => parseHarnessDockDeepLink('harnessdock://workspace/open?path=%2Ftmp%2Fdemo'))
      .toThrow(InvalidHarnessDockDeepLinkError)
    expect(() => parseHarnessDockDeepLink('harnessdock://workspace/open?path=C%3A%5CUsers%5Cdemo'))
      .toThrow(InvalidHarnessDockDeepLinkError)
  })

  it('requires one-time OAuth state and exactly one terminal result', () => {
    expect(parseHarnessDockDeepLink('harnessdock://auth/callback?provider=demo&state=nonce-1&code=abc')).toEqual({
      type: 'auth-callback', provider: 'demo', state: 'nonce-1', code: 'abc', error: undefined,
    })
    expect(deepLinkIntentToCommand(parseHarnessDockDeepLink('harnessdock://auth/callback?state=s&error=denied')))
      .toEqual({ name: 'auth.callback', payload: { type: 'auth-callback', state: 's', error: 'denied', provider: undefined, code: undefined } })
    expect(() => parseHarnessDockDeepLink('harnessdock://auth/callback?code=abc')).toThrow(InvalidHarnessDockDeepLinkError)
    expect(() => parseHarnessDockDeepLink('harnessdock://auth/callback?state=s&code=a&error=b')).toThrow(InvalidHarnessDockDeepLinkError)
  })

  it('rejects unknown protocols, oversized identifiers and missing sensitive pairing parameters', () => {
    expect(() => parseHarnessDockDeepLink('https://example.com/session/1')).toThrow(InvalidHarnessDockDeepLinkError)
    expect(() => parseHarnessDockDeepLink('harnessdock://pair')).toThrow(InvalidHarnessDockDeepLinkError)
    expect(() => parseHarnessDockDeepLink(`harnessdock://session/${'a'.repeat(300)}`)).toThrow(InvalidHarnessDockDeepLinkError)
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
    expect(() => transitionUpdate(state, { phase: 'succeeded' }, now)).toThrow(InvalidUpdateTransitionError)
  })
})

describe('diagnostics redaction', () => {
  it('redacts nested secrets before diagnostics leave the client', () => {
    expect(redactDiagnostics({
      runtime: { version: '0.1.1' }, authorization: 'Bearer secret',
      nested: { apiKey: 'sk-secret', cookie: 'session=secret', safe: 'visible' },
    })).toEqual({
      runtime: { version: '0.1.1' }, authorization: REDACTED,
      nested: { apiKey: REDACTED, cookie: REDACTED, safe: 'visible' },
    })
  })
})
