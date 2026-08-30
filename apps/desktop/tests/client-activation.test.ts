import { describe, expect, it } from 'vitest'
import { extractHarnessDockDeepLinks } from '../src/client-activation.ts'

describe('Electron client activation', () => {
  it('extracts HarnessDock protocol URLs from ordinary Electron argv', () => {
    expect(
      extractHarnessDockDeepLinks([
        '/Applications/HarnessDock.app/Contents/MacOS/HarnessDock',
        '--allow-file-access-from-files',
        'harnessdock://session/session-123',
        'HARNESSDOCK://plugin/install?id=demo.plugin',
      ]),
    ).toEqual([
      'harnessdock://session/session-123',
      'HARNESSDOCK://plugin/install?id=demo.plugin',
    ])
  })

  it('does not treat arbitrary web URLs or file paths as protocol activations', () => {
    expect(
      extractHarnessDockDeepLinks([
        'https://example.com/harnessdock://fake',
        '/tmp/harnessdock://not-a-url',
        'file:///tmp/example',
      ]),
    ).toEqual([])
  })
})
