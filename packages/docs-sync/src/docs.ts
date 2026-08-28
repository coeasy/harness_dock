import { createHash } from 'node:crypto'
import type { GuideCapability } from './types.ts'

const HEADING_TO_ID: Record<string, string> = {
  配置模型: 'configure-models',
  'Configure a model': 'configure-models',
  选择工作区: 'choose-workspace',
  'Choose a workspace': 'choose-workspace',
  运行任务: 'run-task',
  'Run a task': 'run-task',
}

export function extractGuideCapabilities(
  markdown: string,
  source = 'docs/user/guide/index.zh.md',
): GuideCapability[] {
  const capabilities: GuideCapability[] = []
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^##\s+(.+)$/.exec(line.trim())
    if (!match) continue
    const title = match[1]!.trim()
    const id = HEADING_TO_ID[title]
    if (!id) continue
    capabilities.push({ id, title, source })
  }
  return capabilities
}

export function hashDocs(files: Record<string, string>): string {
  const hash = createHash('sha256')
  for (const name of Object.keys(files).sort()) {
    hash.update(name)
    hash.update('\0')
    hash.update(files[name] ?? '')
    hash.update('\0')
  }
  return hash.digest('hex')
}
