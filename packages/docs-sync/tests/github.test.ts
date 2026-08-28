import { describe, expect, it } from 'vitest'
import { parseGitLsRemote } from '../src/github.ts'

describe('parseGitLsRemote', () => {
  it('keeps peeled commit SHAs for dsh-v tags', () => {
    const tags = parseGitLsRemote(`
aaa	refs/tags/dsh-v0.1.1-rc.1
bbb	refs/tags/dsh-v0.1.1-rc.2
bbb	refs/tags/dsh-v0.1.1-rc.2^{}
ccc	refs/tags/v1.0.0
`)
    expect(tags).toEqual([
      { tag: 'dsh-v0.1.1-rc.1', version: '0.1.1-rc.1', sha: 'aaa' },
      { tag: 'dsh-v0.1.1-rc.2', version: '0.1.1-rc.2', sha: 'bbb' },
    ])
  })
})
