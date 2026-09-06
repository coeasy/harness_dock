import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = (command: string, args: string[]) =>
  spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8' })

describe('self-contained local client build', () => {
  it('routes root desktop packaging through the canonical build chain', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['tauri:build']).toBe('node scripts/build.mjs')
    expect(pkg.scripts['build:desktop']).toBe('node scripts/build.mjs')
    expect(pkg.scripts['local:prepare-runtime']).toBe('node scripts/prepare-local-runtime.mjs')
    expect(pkg.scripts['dev:dsh']).toBe('node scripts/dev-dsh.mjs')
  })

  it('keeps generated local Runtime/tool/cache state out of git', () => {
    const gitignore = readFileSync(path.join(repoRoot, '.gitignore'), 'utf8')
    for (const marker of [
      '.local-cache/',
      '.local-tools/',
      '.local-logs/',
      'apps/tauri/src-tauri/resources/dsh-runtime/',
    ]) {
      expect(gitignore).toContain(marker)
    }
  })

  it('keeps JavaScript build and contract entrypoints syntactically valid', () => {
    for (const relative of [
      'scripts/build.mjs',
      'scripts/prepare-local-runtime.mjs',
      'scripts/dev-dsh.mjs',
      'scripts/dev-dsh-runtime.mjs',
      'scripts/check-tauri-source-layout.mjs',
      'scripts/generate-shell-contract.mjs',
      'scripts/generate-runtime-ready-contract.mjs',
    ]) {
      const result = run(process.execPath, ['--check', path.join(repoRoot, relative)])
      expect(result.status, `${relative}: ${result.stderr}`).toBe(0)
    }
  })

  it('parses the platform bootstrap scripts', () => {
    if (process.platform === 'win32') {
      const script = path.join(repoRoot, 'scripts/bootstrap-node.ps1').replaceAll("'", "''")
      const command = `$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$tokens, [ref]$errors) > $null; if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }`
      const result = run('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command])
      expect(result.status, result.stderr).toBe(0)
      return
    }

    for (const relative of ['scripts/build.sh', 'scripts/bootstrap-node.sh']) {
      const result = run('bash', ['-n', path.join(repoRoot, relative)])
      expect(result.status, `${relative}: ${result.stderr}`).toBe(0)
    }
  })

  it('executes the canonical Tauri source-layout gate instead of duplicating module paths in tests', () => {
    const result = run(process.execPath, [path.join(repoRoot, 'scripts/check-tauri-source-layout.mjs')])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('canonical module paths present')
  })

  it('keeps removed legacy build launchers absent', () => {
    for (const relative of [
      'scripts/build-pipeline.mjs',
      'scripts/dev-dsh.sh',
      'scripts/dev-dsh.bat',
      'scripts/regenerate-icon.ps1',
    ]) {
      expect(existsSync(path.join(repoRoot, relative)), `${relative} must stay deleted`).toBe(false)
    }
  })
})
