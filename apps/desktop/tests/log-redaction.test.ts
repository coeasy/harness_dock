import { describe, expect, it } from 'vitest'
import {
  networkStateFromError,
  proxyModeFromRules,
  redactLogText,
  safeNetworkTarget,
} from '../src/log-redaction.ts'

describe('structured log/network sanitization', () => {
  it('redacts bearer, query and key=value secrets from human log text', () => {
    const input =
      'GET https://example.test/callback?code=oauth-code&token=secret Authorization=topsecret Bearer abc.def.ghi'
    const output = redactLogText(input)
    expect(output).not.toContain('oauth-code')
    expect(output).not.toContain('token=secret')
    expect(output).not.toContain('topsecret')
    expect(output).not.toContain('abc.def.ghi')
    expect(output).toContain('[REDACTED]')
  })

  it('strips credentials/query/hash from active network diagnostic targets', () => {
    expect(
      safeNetworkTarget('https://user:pass@example.test/path?token=secret#access_token=hidden'),
    ).toBe('https://example.test/path')
    expect(() => safeNetworkTarget('file:///tmp/test')).toThrow()
  })

  it('reports only proxy category rather than proxy endpoint details', () => {
    expect(proxyModeFromRules('DIRECT')).toBe('direct')
    expect(proxyModeFromRules('PROXY corp.proxy.internal:8080; DIRECT')).toBe('proxy')
    expect(proxyModeFromRules('SOCKS5 127.0.0.1:1080')).toBe('proxy')
  })

  it('classifies common Chromium/Node network failures without retaining messages', () => {
    expect(networkStateFromError({ code: 'ERR_NAME_NOT_RESOLVED' })).toEqual({
      state: 'dns-error',
      errorCode: 'ERR_NAME_NOT_RESOLVED',
    })
    expect(networkStateFromError(new Error('net::ERR_PROXY_CONNECTION_FAILED'))).toEqual({
      state: 'proxy-error',
    })
    expect(networkStateFromError(new Error('net::ERR_CERT_AUTHORITY_INVALID'))).toEqual({
      state: 'tls-error',
    })
    expect(networkStateFromError({ code: 'ENETUNREACH' })).toEqual({
      state: 'offline',
      errorCode: 'ENETUNREACH',
    })
  })
})
