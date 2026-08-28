import { describe, expect, it } from 'vitest'
import { extractGuideCapabilities, hashDocs } from '../src/docs.ts'

const GUIDE = `# 使用 Web UI

## 配置模型

打开**设置 → 模型**，输入 API 密钥并保存。

## 选择工作区

点击**选择工作区**。选中工作区前，会话输入框不可用。

## 运行任务

Agent 可以读取和编辑工作区文件。如果需要审批，Web UI 会先询问你。
`

describe('extractGuideCapabilities', () => {
  it('turns user-guide headings into capability ids', () => {
    const caps = extractGuideCapabilities(GUIDE)
    expect(caps.map((c) => c.id)).toEqual([
      'configure-models',
      'choose-workspace',
      'run-task',
    ])
    expect(caps[0]?.title).toBe('配置模型')
  })
})

describe('hashDocs', () => {
  it('is stable for the same files regardless of insertion order', () => {
    const a = hashDocs({ 'b.md': 'two', 'a.md': 'one' })
    const b = hashDocs({ 'a.md': 'one', 'b.md': 'two' })
    expect(a).toBe(b)
    expect(a).toMatch(/^[a-f0-9]{64}$/)
  })

  it('changes when a file changes', () => {
    expect(hashDocs({ 'a.md': 'one' })).not.toBe(hashDocs({ 'a.md': 'two' }))
  })
})
