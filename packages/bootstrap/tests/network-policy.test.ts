import { describe, expect, it } from 'vitest'
import {
  InvalidNetworkProxyPolicyError,
  normalizeNetworkProxyPolicy,
  normalizeReconnectPolicy,
  reconnectDelayMs,
} from '../src/network-policy.ts'

describe('network proxy policy', () => {
  it('normalizes non-secret HTTP/SOCKS endpoints and bypass rules', () => {
    expect(
      normalizeNetworkProxyPolicy({
        mode: 'http',
        endpoint: 'http://proxy.example:8080',
        bypass: ['localhost', '*.internal', 'localhost'],
      }),
    ).toEqual({
      mode: 'http',
      endpoint: 'http://proxy.example:8080/',
      bypass: ['localhost', '*.internal'],
    })
    expect(
      normalizeNetworkProxyPolicy({ mode: 'socks5', endpoint: 'socks5://127.0.0.1:1080' }),
    ).toEqual({ mode: 'socks5', endpoint: 'socks5://127.0.0.1:1080' })
  })

  it('never accepts proxy credentials or ambiguous endpoint paths', () => {
    expect(() =>
      normalizeNetworkProxyPolicy({
        mode: 'http',
        endpoint: 'http://user:secret@proxy.example:8080',
      }),
    ).toThrow(InvalidNetworkProxyPolicyError)
    expect(() =>
      normalizeNetworkProxyPolicy({ mode: 'https', endpoint: 'https://proxy.example/path' }),
    ).toThrow(InvalidNetworkProxyPolicyError)
    expect(() =>
      normalizeNetworkProxyPolicy({ mode: 'http', endpoint: 'socks5://127.0.0.1:1080' }),
    ).toThrow(InvalidNetworkProxyPolicyError)
  })
})

describe('remote reconnect policy', () => {
  it('uses bounded exponential backoff with deterministic jitter injection', () => {
    const policy = normalizeReconnectPolicy({
      initialDelayMs: 1_000,
      maxDelayMs: 5_000,
      multiplier: 2,
      jitterRatio: 0.2,
      maxAttempts: 5,
    })
    expect(reconnectDelayMs(0, policy, () => 0.5)).toBe(1_000)
    expect(reconnectDelayMs(1, policy, () => 0.5)).toBe(2_000)
    expect(reconnectDelayMs(2, policy, () => 0.5)).toBe(4_000)
    expect(reconnectDelayMs(3, policy, () => 0.5)).toBe(5_000)
    expect(reconnectDelayMs(0, policy, () => 0)).toBe(800)
    expect(reconnectDelayMs(0, policy, () => 1)).toBe(1_200)
  })

  it('rejects unsafe reconnect limits', () => {
    expect(() => normalizeReconnectPolicy({ multiplier: 0.5 })).toThrow()
    expect(() => normalizeReconnectPolicy({ jitterRatio: 1.5 })).toThrow()
    expect(() => normalizeReconnectPolicy({ maxAttempts: 0 })).toThrow()
  })
})
