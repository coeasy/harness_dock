import { describe, expect, it } from 'vitest'
import { resolvePackedRuntimeClosure, type PackedPackageMeta } from './packed-closure.ts'

function packages(entries: PackedPackageMeta[]): Map<string, PackedPackageMeta> {
  return new Map(entries.map((entry) => [entry.name, entry]))
}

describe('resolvePackedRuntimeClosure', () => {
  it('keeps required dependencies and required local peers', () => {
    const result = resolvePackedRuntimeClosure(
      packages([
        {
          name: '@deepseek-ai/dsh',
          version: '1.0.0',
          dependencies: { '@deepseek-ai/web': '^1.0.0', commander: '^15.0.0' },
        },
        {
          name: '@deepseek-ai/web',
          version: '1.0.0',
          peerDependencies: { '@deepseek-ai/vendor': '^1.0.0' },
        },
        { name: '@deepseek-ai/vendor', version: '1.0.0' },
        { name: '@deepseek-ai/unrelated-testkit', version: '1.0.0' },
      ]),
    )

    expect(result).toEqual(['@deepseek-ai/dsh', '@deepseek-ai/vendor', '@deepseek-ai/web'])
  })

  it('does not promote optional peers or unrelated packed packages', () => {
    const result = resolvePackedRuntimeClosure(
      packages([
        {
          name: '@deepseek-ai/dsh',
          version: '1.0.0',
          peerDependencies: { '@deepseek-ai/optional-platform': '^1.0.0' },
          peerDependenciesMeta: { '@deepseek-ai/optional-platform': { optional: true } },
        },
        { name: '@deepseek-ai/optional-platform', version: '1.0.0' },
        { name: '@deepseek-ai/test-runtime', version: '1.0.0' },
      ]),
    )

    expect(result).toEqual(['@deepseek-ai/dsh'])
  })

  it('fails closed when the dsh entry tarball is absent', () => {
    expect(() => resolvePackedRuntimeClosure(packages([]))).toThrow(
      'packed runtime does not contain @deepseek-ai/dsh',
    )
  })
})
