import { describe, expect, it } from 'vitest'
import { syncDsh } from '../src/sync.ts'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const fetchImpl: typeof fetch = async (input) => {
  const url = String(input)
  if (url.includes('/git/matching-refs/tags/dsh-v')) {
    return jsonResponse([
      {
        ref: 'refs/tags/dsh-v0.1.1-rc.2',
        object: { sha: 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e', type: 'commit' },
      },
      {
        ref: 'refs/tags/dsh-v0.1.2-alpha.1',
        object: { sha: 'cd5ef8148158c3a752a658978873241fdf8e2bbc', type: 'commit' },
      },
    ])
  }
  if (url === 'https://registry.npmjs.org/@deepseek-ai/dsh') {
    return jsonResponse({ versions: { '0.1.1-rc.2': {} } })
  }
  if (url.includes('index.zh.md')) {
    return new Response('## 配置模型\n\n## 选择工作区\n\n## 运行任务\n', { status: 200 })
  }
  if (url.includes('raw.githubusercontent.com')) return new Response('missing', { status: 404 })
  return new Response(`not mocked: ${url}`, { status: 500 })
}

describe('Git-only dsh origin', () => {
  it('selects the newest exact Git release even before npm publication', async () => {
    const result = await syncDsh({ fetchImpl, dryRun: true })
    expect(result.origin.dshVersion).toBe('0.1.2-alpha.1')
    expect(result.origin.gitTag).toBe('dsh-v0.1.2-alpha.1')
    expect(result.origin.gitCommit).toBe('cd5ef8148158c3a752a658978873241fdf8e2bbc')
    expect(result.origin.distribution).toBe('git-pack')
    expect(result.origin.npmIntegrity).toBe('')
    expect(result.origin.npmTarball).toBe('')
  })
})
