import { describe, expect, it } from 'vitest'
import {
  assertGatewayConnectUrl,
  assertGatewayHealthPayload,
  normalizeHarnessGatewayOrigin,
} from '../src/mobile-gateway-contract.ts'

describe('mobile gateway contract', () => {
  it('requires HTTPS for public gateways and permits loopback HTTP for development', () => {
    expect(normalizeHarnessGatewayOrigin('https://dock.example.com').href).toBe('https://dock.example.com/')
    expect(normalizeHarnessGatewayOrigin('http://127.0.0.1:43123').href).toBe('http://127.0.0.1:43123/')
    expect(() => normalizeHarnessGatewayOrigin('http://dock.example.com')).toThrow(/HTTPS/)
  })

  it('rejects credential, path and cross-origin connect URL injection', () => {
    expect(() => normalizeHarnessGatewayOrigin('https://user:pass@dock.example.com')).toThrow(/credentials/)
    expect(() => normalizeHarnessGatewayOrigin('https://dock.example.com/subpath')).toThrow(/path/)
    expect(() => assertGatewayConnectUrl('https://dock.example.com', 'https://evil.example/connect')).toThrow(/origin/)
    expect(() => assertGatewayConnectUrl(
      'https://dock.example.com',
      'https://dock.example.com/api/harnessdock/connect?token=ok&extra=unexpected',
    )).toThrow(/one-time/)
  })

  it('requires the versioned health response and keeps its app URL same-origin', () => {
    expect(assertGatewayHealthPayload('https://dock.example.com', {
      schemaVersion: 1,
      ok: true,
      provider: 'remote',
      appUrl: 'https://dock.example.com/',
    }).ok).toBe(true)
    expect(() => assertGatewayHealthPayload('https://dock.example.com', { ok: true })).toThrow(/contract/)
    expect(() => assertGatewayHealthPayload('https://dock.example.com', {
      schemaVersion: 1,
      ok: true,
      provider: 'remote',
      appUrl: 'https://evil.example/',
    })).toThrow(/origin/)
  })
})
