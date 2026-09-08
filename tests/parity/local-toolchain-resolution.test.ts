import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')

describe('local build toolchain resolution', () => {
  it('uses a compatible system Node before the verified portable fallback', () => {
    const shell = read('scripts/build.sh')
    const batch = read('scripts/build.bat')

    expect(shell).toContain('command -v node')
    expect(shell).toContain('node scripts/node-version-check.cjs')
    expect(shell).toContain('Using compatible system Node')
    expect(shell).toContain('HARNESSDOCK_FORCE_PORTABLE_NODE=1; bypassing system Node')
    expect(shell.indexOf('command -v node')).toBeLessThan(shell.indexOf('bash scripts/bootstrap-node.sh'))

    expect(batch).toContain('where node.exe')
    expect(batch).toContain('node scripts\\node-version-check.cjs')
    expect(batch).toContain('Using compatible system Node')
    expect(batch).toContain('HARNESSDOCK_FORCE_PORTABLE_NODE=1; bypassing system Node')
    expect(batch.indexOf('where node.exe')).toBeLessThan(batch.indexOf('bootstrap-node.ps1'))
  })

  it('reuses exact pnpm or provisions it under .local-tools without global mutation', () => {
    const bootstrap = read('scripts/bootstrap.mjs')
    const shell = read('scripts/build.sh')
    const batch = read('scripts/build.bat')

    expect(bootstrap).toContain("const localPnpmRoot = path.join(toolRoot, `pnpm-${expectedPnpmVersion}`)")
    expect(bootstrap).toContain("const pnpmBinFile = path.join(toolRoot, 'pnpm-bin.txt')")
    expect(bootstrap).toContain("pnpmSource = 'system PATH'")
    expect(bootstrap).toContain("pnpmSource = '.local-tools'")
    expect(bootstrap).toContain("'--prefix', localPnpmRoot")
    expect(bootstrap).toContain("'--package-lock=false'")
    expect(bootstrap).not.toContain("run('corepack', ['enable'])")
    expect(bootstrap).not.toContain("'install', '-g'")

    expect(shell).toContain('.local-tools/pnpm-bin.txt')
    expect(shell).toContain('export PATH="$pnpm_bin:$PATH"')
    expect(shell).toContain('Using repository-local pnpm')

    expect(batch).toContain('.local-tools\\pnpm-bin.txt')
    expect(batch).toContain('set "PATH=%PNPM_BIN%;%PATH%"')
    expect(batch).toContain('Using repository-local pnpm')
  })
})
