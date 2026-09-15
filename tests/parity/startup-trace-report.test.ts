import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('native startup performance report', () => {
  it('reports structured startup phases without depending on legacy boot logs', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harnessdock-startup-trace-test-'))
    const trace = path.join(dir, 'startup-42.log')
    writeFileSync(
      trace,
      [
        '[+0ms] phase=process_started',
        '[+120ms] phase=runtime_start',
        '[+1682ms] phase=runtime_ready',
        '[+1715ms] phase=webview_requested',
        '',
      ].join('\n'),
    )

    try {
      const output = execFileSync(process.execPath, [path.join(repoRoot, 'scripts/perf-report.mjs'), trace], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
      expect(output).toContain('startup duration: 1715 ms')
      expect(output).toContain('terminal: webview_requested')
      expect(output).toContain('runtime_ready: +1682 ms')
      expect(output).toContain('webview_requested: +1715 ms (delta 33 ms)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
