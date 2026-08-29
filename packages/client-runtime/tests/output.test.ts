import { describe, expect, it } from 'vitest'
import { parseWebUrl, redactWebLaunchToken } from '../src/output.ts'

describe('parseWebUrl', () => {
  it('extracts the legacy loopback URL printed by dsh web', () => {
    expect(parseWebUrl('dsh web: http://127.0.0.1:43123\n')).toEqual({
      url: 'http://127.0.0.1:43123',
      host: '127.0.0.1',
      port: 43123,
    })
  })

  it('preserves the alpha authentication query for readiness and renderer load', () => {
    expect(
      parseWebUrl('dsh web: http://127.0.0.1:43123/?token=abcDEF_123-xyz\n'),
    ).toEqual({
      url: 'http://127.0.0.1:43123/?token=abcDEF_123-xyz',
      host: '127.0.0.1',
      port: 43123,
    })
  })

  it('does not absorb terminal ANSI escapes into the URL', () => {
    expect(parseWebUrl('dsh web: http://127.0.0.1:43123/?token=abc\u001b[0m')).toEqual({
      url: 'http://127.0.0.1:43123/?token=abc',
      host: '127.0.0.1',
      port: 43123,
    })
  })

  it('ignores unrelated lines and 0.0.0.0', () => {
    expect(parseWebUrl('listening on 0.0.0.0:3080')).toBeNull()
    expect(parseWebUrl('ready')).toBeNull()
  })
})

describe('redactWebLaunchToken', () => {
  it('removes the launch credential while preserving diagnostic structure', () => {
    expect(
      redactWebLaunchToken('dsh web: http://127.0.0.1:43123/?token=secret-value&next=1'),
    ).toBe('dsh web: http://127.0.0.1:43123/?token=<redacted>&next=1')
  })

  it('leaves ordinary URLs untouched', () => {
    expect(redactWebLaunchToken('http://127.0.0.1:43123/')).toBe('http://127.0.0.1:43123/')
  })
})
