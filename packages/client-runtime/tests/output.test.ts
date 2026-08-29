import { describe, expect, it } from 'vitest'
import { parseWebUrl, redactWebAuthTokens } from '../src/output.ts'

describe('parseWebUrl', () => {
  it('extracts the loopback URL printed by older dsh web versions', () => {
    expect(parseWebUrl('dsh web: http://127.0.0.1:43123\n')).toEqual({
      url: 'http://127.0.0.1:43123',
      host: '127.0.0.1',
      port: 43123,
    })
  })

  it('preserves the dsh 0.1.2 browser launch token', () => {
    expect(parseWebUrl('dsh web: http://127.0.0.1:43123/?token=abc_DEF-123\n')).toEqual({
      url: 'http://127.0.0.1:43123/?token=abc_DEF-123',
      host: '127.0.0.1',
      port: 43123,
    })
  })

  it('ignores unrelated lines and 0.0.0.0', () => {
    expect(parseWebUrl('listening on 0.0.0.0:3080')).toBeNull()
    expect(parseWebUrl('ready')).toBeNull()
  })
})

describe('redactWebAuthTokens', () => {
  it('removes browser launch credentials without changing the URL shape', () => {
    expect(redactWebAuthTokens('dsh web: http://127.0.0.1:43123/?token=abc_DEF-123')).toBe(
      'dsh web: http://127.0.0.1:43123/?token=<redacted>',
    )
  })
})
