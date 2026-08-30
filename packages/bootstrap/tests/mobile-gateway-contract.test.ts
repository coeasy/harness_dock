import { describe, expect, it } from 'vitest'
import {
  assertGatewayConnectUrl,
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
  })
})
