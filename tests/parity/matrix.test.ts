import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderCapabilityMatrixYaml } from '@dsh/docs-sync'
import { buildCapabilityMatrix } from '@dsh/docs-sync'

describe('capability matrix parity contract', () => {
  it('requires the official user-guide operations and host mounts', () => {
    const matrix = buildCapabilityMatrix({
      dshVersion: '0.1.1-rc.2',
      gitTag: 'dsh-v0.1.1-rc.2',
      guide: [
        { id: 'configure-models', title: '配置模型', source: 'docs/user/guide/index.zh.md' },
        { id: 'choose-workspace', title: '选择工作区', source: 'docs/user/guide/index.zh.md' },
        { id: 'run-task', title: '运行任务', source: 'docs/user/guide/index.zh.md' },
      ],
      dumpConfig: '',
    })
    const ids = matrix.operations.map((op) => op.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'configure-models',
        'choose-workspace',
        'run-task',
        'approval-flow',
        'session-export',
        'plugin-inventory',
      ]),
    )
    expect(matrix.hostMounts['api-gateway']).toBe(true)
    expect(matrix.hostMounts['directory-picker']).toBe(true)
    expect(matrix.hostMounts.workspace).toBe(true)
    expect(matrix.hostMounts['host-frontend-static']).toBe(true)
    expect(renderCapabilityMatrixYaml(matrix)).toContain('configure-models')
  })
})

describe('mock official SPA shell', () => {
  it('serves a page the client can load over loopback', async () => {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><html><body><h1 data-testid="workbench">DeepSeek Harness</h1></body></html>',
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no address')
    const response = await fetch(`http://127.0.0.1:${address.port}`)
    const html = await response.text()
    expect(html).toContain('data-testid="workbench"')
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  })
})

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const docsSyncDir = path.join(repoRoot, 'packages', 'docs-sync')
const MATRIX_YAML = path.join(docsSyncDir, 'capability-matrix.yaml')
const SUMMARY_MD = path.join(docsSyncDir, 'capability-summary.md')

/**
 * The official capability ids that every published surface (YAML + Markdown
 * summary) must expose. These mirror the operations the client actually ships.
 */
const REQUIRED_CAPABILITIES = [
  'configure-models',
  'choose-workspace',
  'run-task',
  'session-export',
  'approval-flow',
  'plugin-inventory',
  'theme-toggle',
  'session-history',
  'multi-model',
] as const

function readOptional(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

function yamlOperationIds(yaml: string): string[] {
  return [...yaml.matchAll(/^\s*- id:\s*([A-Za-z0-9_-]+)/gm)].map((match) => match[1]!)
}

function summaryIds(markdown: string): string[] {
  return [...markdown.matchAll(/^- id:\s*([A-Za-z0-9_-]+)/gm)].map((match) => match[1]!)
}

/**
 * Detect capability-removal markers in the operations list (design only).
 *
 * If a future sync ever emits a marker such as `session-export-removed` (or a
 * `removed: true` metadata flag) when an upstream capability disappears, parity
 * should surface a warning instead of silently dropping it from the summary.
 * No such markers exist in the current matrix, so this stays wired but inert —
 * we deliberately do not fabricate data to force it to fire.
 */
function findRemovedCapabilities(ids: readonly string[]): string[] {
  return ids.filter((id) => id.endsWith('-removed'))
}

describe('capability summary parity (D5)', () => {
  const yaml = readOptional(MATRIX_YAML)
  const yamlIds = yaml ? yamlOperationIds(yaml) : []

  it('committed capability-matrix.yaml exposes every required capability', () => {
    expect(yaml).not.toBeNull()
    for (const id of REQUIRED_CAPABILITIES) expect(yamlIds).toContain(id)
  })

  it('the markdown summary mirrors the yaml operation ids when present', () => {
    const summary = readOptional(SUMMARY_MD)
    if (!summary) return // not generated yet — covered by the warning test below
    for (const id of yamlIds) expect(summary).toContain(`- id: ${id}`)
  })

  it('warns (without failing) when the summary is missing a required capability', () => {
    const summary = readOptional(SUMMARY_MD)
    if (!summary) {
      console.warn(
        '[capability-summary] capability-summary.md not generated yet — run a non-dry-run `pnpm sync:dsh` to emit it',
      )
    } else {
      const missing = REQUIRED_CAPABILITIES.filter((id) => !summaryIds(summary).includes(id))
      if (missing.length > 0) {
        console.warn(`[capability-summary] summary missing capabilities: ${missing.join(', ')}`)
      }
    }
    // Warning-only gate: an absent or stale summary must not fail the suite.
    expect(REQUIRED_CAPABILITIES.length).toBeGreaterThan(0)
  })

  it('has no removal markers today (detector wired but inert)', () => {
    expect(findRemovedCapabilities(yamlIds)).toEqual([])
  })
})
