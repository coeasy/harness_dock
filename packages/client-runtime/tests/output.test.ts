import { describe, expect, it } from 'vitest'
import { parseWebUrl } from '../src/output.ts'

describe('parseWebUrl', () => {
  it('extracts the loopback URL printed by dsh web', () => {
    expect(parseWebUrl('dsh web: http://127.0.0.1:43123\n')).toEqual({
      url: 'http://127.0.0.1:43123',
      host: '127.0.0.1',
      port: 43123,
    })
  })

  it('ignores unrelated lines and 0.0.0.0', () => {
    expect(parseWebUrl('listening on 0.0.0.0:3080')).toBeNull()
    expect(parseWebUrl('ready')).toBeNull()
  })
})
