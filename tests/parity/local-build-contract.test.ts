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

    expect(batch).toContain('bootstrap-node.ps1')
    expect(batch).toContain('HARNESSDOCK_FORCE_PORTABLE_NODE')
    expect(batch).toContain('node scripts\\bootstrap.mjs')
    expect(batch).toContain('node scripts\\build.mjs --skip-install')
    expect(windowsBootstrap).toContain('SHASUMS256.txt')
    expect(windowsBootstrap).toContain('Get-FileHash -Algorithm SHA256')
    expect(windowsBootstrap).toContain('NODE_DOWNLOAD_BASES')
    expect(windowsBootstrap).toContain('.local-tools')

    expect(shell).toContain('HARNESSDOCK_FORCE_PORTABLE_NODE')
    expect(shell).toContain('bash scripts/bootstrap-node.sh')
    expect(shell).toContain('.local-tools/node-home.txt')
    expect(shell).toContain('node scripts/bootstrap.mjs')
    expect(shell).toContain('node scripts/build.mjs --skip-install')
    expect(posixBootstrap).toContain('SHASUMS256.txt')
    expect(posixBootstrap).toContain('sha256sum')
    expect(posixBootstrap).toContain('node-home.txt')
    expect(posixBootstrap).not.toContain('build.mjs')

    expect(posixBootstrap).toContain('NODE_DOWNLOAD_BASES')
    expect(posixBootstrap).toContain('https://nodejs.org/dist/v')
    expect(posixBootstrap).toContain('https://npmmirror.com/mirrors/node/v')
    expect(posixBootstrap).toContain('CYGWIN*|MINGW*|MSYS*')
    expect(posixBootstrap).toContain('bootstrap-node.ps1')
  })

  it('prefers a compatible system Node locally while CI can force the verified portable fallback', () => {
    const batch = read('scripts/build.bat')
    const shell = read('scripts/build.sh')

    expect(shell).toContain('command -v node')
    expect(shell).toContain('node scripts/node-version-check.cjs')
    expect(shell).toContain('Using compatible system Node')
    expect(shell).toContain('System Node not found; falling back to verified portable Node')
    expect(shell).toContain('System Node $(node --version')
    expect(shell).toContain('HARNESSDOCK_FORCE_PORTABLE_NODE=1; bypassing system Node')
    expect(shell.indexOf('command -v node')).toBeLessThan(shell.indexOf('bash scripts/bootstrap-node.sh'))

    expect(batch).toContain('where node.exe')
    expect(batch).toContain('node scripts\\node-version-check.cjs')
    expect(batch).toContain('Using compatible system Node')
    expect(batch).toContain('System Node not found; falling back to verified portable Node')
    expect(batch).toContain('System Node %SYSTEM_NODE_VERSION% is incompatible')
    expect(batch).toContain('HARNESSDOCK_FORCE_PORTABLE_NODE=1; bypassing system Node')
    expect(batch.indexOf('where node.exe')).toBeLessThan(batch.indexOf('bootstrap-node.ps1'))
  })

  it('requires the exact sealed runtime identity rather than version-only reuse', () => {
    const prepare = read('scripts/prepare-local-runtime.mjs')
    const runtimeBuilder = read('packages/client-runtime/src/prepare-cli.ts')
    const imageIdentity = read('packages/client-runtime/src/image-identity.ts')
    const prune = read('packages/client-runtime/src/prune-node-cli.ts')

    for (const field of [
      'platform',
      'arch',
      'dshVersion',
      'gitTag',
      'gitCommit',
      'dshGitTag',
      'dshGitCommit',
      'clientVersion',
      'schemaVersion',
      'runtimeLayoutVersion',
      'imageIdentityAlgorithm',
      'runtimeEmbedded',
      'firstLaunchRuntimeDownloadRequired',
      'imageIdentity',
      'contentFileCount',
      'contentBytes',
    ]) {
      expect(prepare).toContain(field)
    }

    expect(prepare).toContain('origin.gitTag')
    expect(prepare).toContain('origin.gitCommit')
    expect(prepare).toContain('expectedReleaseDigest')
    expect(prepare).toContain("'clone'")
    expect(prepare).toContain("'build:official'")
    expect(prepare).toContain('DSH_PACKED_RUNTIME_DIR')
    expect(prepare).toContain('cached runtime is stale or incompatible; refreshing')

    const builderLayout = /const RUNTIME_LAYOUT_VERSION = (\d+)/.exec(runtimeBuilder)?.[1]
    const localLayout = /const RUNTIME_LAYOUT_VERSION = (\d+)/.exec(prepare)?.[1]
    expect(localLayout).toBe(builderLayout)

    const identityAlgorithm = /const IDENTITY_ALGORITHM = '([^']+)'/.exec(imageIdentity)?.[1]
    const localIdentityAlgorithm = /const RUNTIME_IMAGE_IDENTITY_ALGORITHM = '([^']+)'/.exec(prepare)?.[1]
    expect(localIdentityAlgorithm).toBe(identityAlgorithm)

    const runtimeSchema = /manifest\.schemaVersion = (\d+)/.exec(prune)?.[1]
    const localSchema = /const RUNTIME_SCHEMA_VERSION = (\d+)/.exec(prepare)?.[1]
    expect(localSchema).toBe(runtimeSchema)
  })

  it('pins pnpm and tauri-cli and reconciles stale workspace dependencies', () => {
    const pkg = JSON.parse(read('package.json')) as { packageManager?: string; scripts: Record<string, string> }
    const versions = JSON.parse(read('scripts/versions.json')) as { node?: string; tauriCli?: string }
    const bootstrap = read('scripts/bootstrap.mjs')
    const build = read('scripts/build.mjs')

    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/)
    expect(versions.tauriCli).toMatch(/^\d+\.\d+\.\d+$/)
    expect(bootstrap).toContain('rootPackage.packageManager')
    expect(bootstrap).toContain('expectedPnpmVersion')
    expect(bootstrap).toContain('exact packageManager match')
    expect(bootstrap).toContain('reconciling workspace with frozen lockfile')
    expect(bootstrap).toContain("['install', '--frozen-lockfile', '--prefer-offline']")
    expect(bootstrap).not.toContain('node_modules present, skip install')
    expect(bootstrap).not.toContain('pnpm@10.12.0')
    expect(build).toContain('versions.tauriCli')
    expect(build).toContain('globalVersion === tauriCliVersion')
    expect(build).toContain('ignoring tauri-cli')
    expect(build).toContain('actualPnpmVersion !== expectedPnpmVersion')
  })

  it('prepares the exact sealed runtime, proves Harness Web, and self-heals corruption once', () => {
    const prepare = read('scripts/prepare-local-runtime.mjs')
    const build = read('scripts/build.mjs')
    const smoke = read('packages/client-runtime/src/smoke-cli.ts')

    expect(prepare).toContain('runtimeEmbedded')
    expect(prepare).toContain('firstLaunchRuntimeDownloadRequired')
    expect(prepare).toContain("'no-source-fallback'")
    expect(build).toContain('scripts/prepare-local-runtime.mjs')
    expect(build).toContain("'smoke-runtime'")
    expect(build).toContain('function runtimePrepareArgs(')
    expect(build).not.toContain("args.push('--no-source-fallback')")
    expect(build).toContain("args.push('--source-only')")
    expect(build).toContain('trusted release or pinned source fallback')
    expect(build).toContain('function verifyRuntime()')
    expect(build).toContain('const firstSmoke = runStatus(')
    expect(build).toContain('runtimePrepareArgs(true)')
    expect(build).toContain('existing Runtime failed verification and --skip-runtime-prepare forbids repair')
    expect(build).toContain('refreshing the same target Runtime once and re-verifying')
    expect(smoke).toContain('assertRuntimeImageIdentity(runtimeDir, manifest)')
    expect(smoke).toContain('assertBundledRuntimeIntegrity')

    const rustGate = build.indexOf("run(pnpmCommand, ['--filter', '@dsh/tauri', 'tauri:check']")
    const runtimePrepareGate = build.indexOf("if (!values['skip-runtime-prepare'])", rustGate)
    expect(rustGate).toBeGreaterThan(-1)
    expect(runtimePrepareGate).toBeGreaterThan(rustGate)

    const checkOnlyGate = build.indexOf("if (values['check-only'])", runtimePrepareGate)
    const packagingTauriGate = build.lastIndexOf('ensureTauriCli()')
    expect(checkOnlyGate).toBeGreaterThan(runtimePrepareGate)
    expect(packagingTauriGate).toBeGreaterThan(checkOnlyGate)
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
    expect(gitignore).toContain('apps/tauri/src-tauri/icons/.app-icon-normalized.png')
    expect(gitignore).toContain('apps/tauri/src-tauri/icons/Square*.png')
  })

  it('keeps the JavaScript build entrypoints syntactically valid', () => {
    for (const relative of [
      'scripts/bootstrap.mjs',
      'scripts/build-targets.mjs',
      'scripts/build.mjs',
      'scripts/prepare-local-runtime.mjs',
    ]) {
      const result = spawnSync(process.execPath, ['--check', path.join(repoRoot, relative)], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
      expect(result.status, `${relative}: ${result.stderr}`).toBe(0)
    }
  })

  it('parses the host shell bootstrap and installer-smoke scripts for the current CI platform', () => {
    if (process.platform === 'win32') {
      for (const relative of ['scripts/bootstrap-node.ps1', 'scripts/smoke-windows-installer.ps1']) {
        const script = path.join(repoRoot, relative).replaceAll("'", "''")
        const command = `$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$tokens, [ref]$errors) > $null; if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }`
        const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], {
          cwd: repoRoot,
          encoding: 'utf8',
        })
        expect(result.status, `${relative}: ${result.stderr}`).toBe(0)
      }
      return
    }

    for (const relative of ['scripts/build.sh', 'scripts/bootstrap-node.sh']) {
      const result = spawnSync('bash', ['-n', path.join(repoRoot, relative)], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
      expect(result.status, `${relative}: ${result.stderr}`).toBe(0)
    }
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
    expect(build).toContain('function verifyRuntime()')
    expect(build).toContain('runtimePrepareArgs')
  })

  it('runs portable Node bootstrap for real on POSIX and Windows, with both mirrors', () => {
    const workflow = read('.github/workflows/ci.yml')
    const posixBootstrap = read('scripts/bootstrap-node.sh')
    const windowsBootstrap = read('scripts/bootstrap-node.ps1')

    expect(workflow).toContain('node-bootstrap:')
    expect(workflow).toContain('bash scripts/bootstrap-node.sh')
    expect(workflow).toContain('portable_version=')
    expect(workflow).toContain('"$node_home/bin/node" scripts/node-version-check.cjs')
    expect(workflow).toContain('mirror: nodejs')
    expect(workflow).toContain('mirror: npmmirror')
    expect(workflow).toContain('os: ubuntu-latest')
    expect(workflow).toContain('os: macos-latest')

    expect(workflow).toContain('node-bootstrap-windows:')
    expect(workflow).toContain('./scripts/bootstrap-node.ps1')
    expect(workflow).toContain('matrix.mirror')
    expect(workflow).toContain('NODE_DOWNLOAD_BASES')
    expect(workflow).toContain('.local-tools/node-home.txt')
    expect(workflow).toContain('.local-cache/node')

    // Mirrors may serve the archive, but must not be allowed to choose the
    // digest used to authenticate it.
    expect(posixBootstrap).toContain('checksum_base="https://nodejs.org/dist/v${node_version}"')
    expect(posixBootstrap).toContain('install_from_mirror "$base" "$checksum_base"')
    expect(posixBootstrap).toContain('"$checksum_base/SHASUMS256.txt"')
    expect(windowsBootstrap).toContain('$ChecksumBaseUrl = "https://nodejs.org/dist/v$Version"')
    expect(windowsBootstrap).toContain('Get-ExpectedHash $ChecksumBaseUrl')
  })

  it('gates the actual clean-clone one-click entrypoints and the exact Windows installer startup', () => {
    const workflow = read('.github/workflows/local-one-click-build.yml')
    const smoke = read('scripts/smoke-windows-installer.ps1')

    expect(workflow).toContain('HARNESSDOCK_FORCE_PORTABLE_NODE')
    expect(workflow).toContain('scripts\\build.bat --skip-tests')
    expect(workflow).toContain('./scripts/build.sh --skip-tests --check-only')
    expect(workflow).toContain('apps/tauri/src-tauri/resources/dsh-runtime')
    expect(workflow).toContain('smoke-windows-installer.ps1')
    expect(workflow).toContain("git status --porcelain")

    expect(smoke).toContain('phase=runtime_ready')
    expect(smoke).toContain('phase=webview_requested')
    expect(smoke).toContain('phase=primary_visible')
    expect(smoke).toContain('127.0.0.1')
    expect(smoke).toContain('CookieContainer')
    expect(smoke).toContain('healthyCleanProbes -ge 2')
  })

  it('asserts the split module roots rather than the pre-R3 single files', () => {
    const workflow = read('.github/workflows/ci.yml')
    for (const relative of [
      'apps/tauri/src-tauri/src/runtime/mod.rs',
      'apps/tauri/src-tauri/src/gateway_host/mod.rs',
      'apps/tauri/src-tauri/src/harness_window/mod.rs',
      'apps/tauri/src-tauri/src/util.rs',
      'apps/tauri/src-tauri/src/error.rs',
    ]) {
      expect(workflow).toContain(`test -s ${relative}`)
    }
    expect(workflow).not.toContain('test -s apps/tauri/src-tauri/src/gateway_host.rs')
  })

  it('keeps the dev-only dsh runner self-sufficient after the dev-dsh.sh removal', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts['dev:dsh']).toBe('node scripts/dev-dsh.mjs')
    expect(pkg.scripts['dev:dsh']).not.toContain('--import tsx')

    const launcher = read('scripts/dev-dsh.mjs')
    const runtime = read('scripts/dev-dsh-runtime.mjs')

    expect(launcher).toContain('pnpm install')
    expect(launcher).toContain('node_modules')
    expect(launcher).toContain('dev-dsh-runtime.mjs')
    expect(launcher).toContain("'--import', 'tsx'")
    expect(launcher).not.toMatch(/^import \{ DshRuntime \}/m)
    expect(launcher).not.toContain('client-runtime/src')

    expect(runtime).toContain("await import('../packages/client-runtime/src/runtime.ts')")
    expect(runtime).toContain('new DshRuntime(')
    expect(runtime).toContain("process.on('SIGINT', shutdown)")
  })
})
