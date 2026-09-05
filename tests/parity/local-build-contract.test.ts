import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')

describe('self-contained local client build', () => {
  it('bootstraps a verified build-time Node on bare hosts, per platform', () => {
    const batch = read('scripts/build.bat')
    const shell = read('scripts/build.sh')
    const windowsBootstrap = read('scripts/bootstrap-node.ps1')
    const posixBootstrap = read('scripts/bootstrap-node.sh')

    // Windows: build.bat delegates portable Node provisioning to bootstrap-node.ps1
    // and then forwards to the same build.mjs entrypoint as every other host.
    expect(batch).toContain('bootstrap-node.ps1')
    expect(batch).toContain('node scripts\\bootstrap.mjs')
    expect(batch).toContain('node scripts\\build.mjs --skip-install')
    expect(windowsBootstrap).toContain('SHASUMS256.txt')
    expect(windowsBootstrap).toContain('Get-FileHash -Algorithm SHA256')
    expect(windowsBootstrap).toContain('.local-tools')

    // POSIX: build.sh is a thin shim over build.mjs and delegates portable Node
    // provisioning to bootstrap-node.sh, which publishes the same
    // .local-tools/node-home.txt contract as the Windows counterpart.
    expect(shell).toContain('bash scripts/bootstrap-node.sh')
    expect(shell).toContain('.local-tools/node-home.txt')
    expect(shell).toContain('node scripts/bootstrap.mjs')
    expect(shell).toContain('node scripts/build.mjs --skip-install')
    expect(posixBootstrap).toContain('SHASUMS256.txt')
    expect(posixBootstrap).toContain('sha256sum')
    expect(posixBootstrap).toContain('node-home.txt')
    expect(posixBootstrap).not.toContain('build.mjs')
  })

  it('prepares the exact sealed runtime instead of assuming resources/dsh-runtime exists', () => {
    const prepare = read('scripts/prepare-local-runtime.mjs')
    const build = read('scripts/build.mjs')

    expect(prepare).toContain('origin.gitTag')
    expect(prepare).toContain('origin.gitCommit')
    expect(prepare).toContain('expectedReleaseDigest')
    expect(prepare).toContain("'clone'")
    expect(prepare).toContain("'build:official'")
    expect(prepare).toContain('DSH_PACKED_RUNTIME_DIR')
    expect(prepare).toContain('runtimeEmbedded === true')
    expect(prepare).toContain('firstLaunchRuntimeDownloadRequired === false')

    expect(build).toContain('scripts/prepare-local-runtime.mjs')
    expect(build).toContain("'smoke-runtime'")
    expect(build).toContain('verify sealed Runtime + Harness Web readiness')
    expect(build).toContain('cargoCommand')
    expect(build).toContain('tauri-cli')
  })

  it('routes normal root desktop packaging through the safe local build chain', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts['tauri:build']).toBe('node scripts/build.mjs')
    expect(pkg.scripts['build:desktop']).toBe('node scripts/build.mjs')
    expect(pkg.scripts['local:prepare-runtime']).toBe('node scripts/prepare-local-runtime.mjs')
  })

  it('keeps generated local Runtime/tool/cache state out of git', () => {
    const gitignore = read('.gitignore')
    expect(gitignore).toContain('.local-cache/')
    expect(gitignore).toContain('.local-tools/')
    expect(gitignore).toContain('.local-logs/')
    expect(gitignore).toContain('apps/tauri/src-tauri/resources/dsh-runtime/')
  })

  it('keeps the JavaScript build entrypoints syntactically valid', () => {
    for (const relative of ['scripts/build.mjs', 'scripts/prepare-local-runtime.mjs']) {
      const result = spawnSync(process.execPath, ['--check', path.join(repoRoot, relative)], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
      expect(result.status, `${relative}: ${result.stderr}`).toBe(0)
    }
  })

  it('parses the host shell bootstrap script for the current CI platform', () => {
    if (process.platform === 'win32') {
      const script = path.join(repoRoot, 'scripts/bootstrap-node.ps1').replaceAll("'", "''")
      const command = `$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$tokens, [ref]$errors) > $null; if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }`
      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
      expect(result.status, result.stderr).toBe(0)
      return
    }

    const result = spawnSync('bash', ['-n', path.join(repoRoot, 'scripts/build.sh')], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    expect(result.status, `scripts/build.sh: ${result.stderr}`).toBe(0)
    const bootstrapResult = spawnSync('bash', ['-n', path.join(repoRoot, 'scripts/bootstrap-node.sh')], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    expect(bootstrapResult.status, `scripts/bootstrap-node.sh: ${bootstrapResult.stderr}`).toBe(0)
  })

  it('keeps one build entrypoint and no dead build/dev scripts', () => {
    for (const relative of [
      'scripts/build-pipeline.mjs',
      'scripts/dev-dsh.sh',
      'scripts/dev-dsh.bat',
      'scripts/regenerate-icon.ps1',
    ]) {
      expect(existsSync(path.join(repoRoot, relative)), `${relative} must stay deleted`).toBe(false)
    }
    const build = read('scripts/build.mjs')
    expect(build).toContain("'smoke-runtime'")
    expect(build).toContain('verify sealed Runtime + Harness Web readiness')
  })
})
