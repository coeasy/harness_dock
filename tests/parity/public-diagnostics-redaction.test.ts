import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8')

describe('public diagnostics secret boundary', () => {
  it('never renders the Runtime launch URL verbatim in the recovery/control page', () => {
    const control = read('apps/tauri/web/app.js')
    expect(control).toContain('function publicText(value)')
    expect(control).toContain('function safeDisplayUrl(value)')
    expect(control).toContain("bad ? publicText(value) : (value || '')")
    expect(control).toContain('safeDisplayUrl(current.appUrl)')
    expect(control).toContain('safeDisplayUrl(current.localUrl)')
    expect(control).toContain('safeDisplayUrl(current.publicUrl)')
    expect(control).not.toContain("[current.dshVersion || '', node, current.appUrl]")
    expect(control).toContain("url.search = ''")
    expect(control).toContain("url.hash = ''")
    expect(control).toContain('Bearer [redacted]')
  })

  it('sanitizes every Shell toast, including bridge event errors', () => {
    const shell = read('packages/plugin-harness-shell/web/shell.js')
    expect(shell).toContain('const publicText = (value) =>')
    expect(shell).toContain('toast.textContent = publicText(message)')
    expect(shell).not.toContain('toast.textContent = message')
    expect(shell).toContain("url.search = ''")
    expect(shell).toContain('Bearer [redacted]')
    expect(shell).toContain("showToast(event.message || '外壳状态异常')")
  })

  it('keeps real credential-bearing URLs only on internal navigation paths', () => {
    const control = read('apps/tauri/web/app.js')
    expect(control).toContain('await openHarnessWithRetry(currentRuntime.appUrl)')
    expect(control).toContain('window.location.assign(paired.connectUrl)')
  })
})
