import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')

describe('local one-click build hardening', () => {
  it('rejects stale Runtime images even when dshVersion is unchanged', () => {
    const prepare = read('scripts/prepare-local-runtime.mjs')

    expect(prepare).toContain("manifest.schemaVersion === 1")
    expect(prepare).toContain('manifest.clientVersion === product.version')
    expect(prepare).toContain('manifest.dshVersion === origin.dshVersion')
    expect(prepare).toContain('pinnedTag === origin.gitTag')
    expect(prepare).toContain('pinnedCommit === origin.gitCommit')
    expect(prepare).toContain("manifest.imageIdentityAlgorithm === 'sha256-v1'")
    expect(prepare).toContain("/^sha256:[a-f0-9]{64}$/i.test(imageIdentity)")
    expect(prepare).toContain('manifest.runtimeEmbedded === true')
    expect(prepare).toContain('manifest.firstLaunchRuntimeDownloadRequired === false')
    expect(prepare).toContain('Number(manifest.contentFileCount) > 0')
    expect(prepare).toContain('Number(manifest.contentBytes) > 0')
  })

  it('can force the exact portable-Node path instead of trusting runner Node', () => {
    const batch = read('scripts/build.bat')
    const shell = read('scripts/build.sh')
    const windowsBootstrap = read('scripts/bootstrap-node.ps1')

    expect(batch).toContain('HARNESSDOCK_FORCE_PORTABLE_NODE')
    expect(batch).toContain('goto :portable_node')
    expect(shell).toContain('HARNESSDOCK_FORCE_PORTABLE_NODE')
    expect(shell).toContain('bash scripts/bootstrap-node.sh')
    expect(windowsBootstrap).toContain('NODE_DOWNLOAD_BASES')
    expect(windowsBootstrap).toContain("-split '\\s+'")
  })

  it('enforces packageManager pnpm without requiring global install permission', () => {
    const bootstrap = read('scripts/bootstrap.mjs')
    const batch = read('scripts/build.bat')
    const shell = read('scripts/build.sh')
    const pkg = JSON.parse(read('package.json')) as { packageManager: string }
    const requiredPnpm = pkg.packageManager.replace(/^pnpm@/, '').split('+')[0]

    expect(bootstrap).toContain('const requiredPnpm = pnpmMatch[1]')
    expect(bootstrap).toContain('pnpm !== requiredPnpm')
    expect(bootstrap).toContain('localPnpmRoot')
    expect(bootstrap).toContain("'--prefix', localPnpmRoot")
    expect(bootstrap).toContain('pnpm-home.txt')
    expect(bootstrap).not.toContain("'install', '-g'")
    expect(batch).toContain('.local-tools\\pnpm-home.txt')
    expect(batch).toContain('set "PATH=%PNPM_HOME%;%PATH%"')
    expect(shell).toContain('.local-tools/pnpm-home.txt')
    expect(shell).toContain('export PATH="$pnpm_home:$PATH"')
    expect(requiredPnpm).toBe('10.12.1')
  })

  it('enforces the exact local Tauri CLI', () => {
    const build = read('scripts/build.mjs')
    expect(build).toContain('const requiredPnpmVersion = pnpmMatch[1]')
    expect(build).toContain('activePnpmVersion !== requiredPnpmVersion')
    expect(build).toContain("const tauriCliVersion = '2.11.4'")
    expect(build).toContain('activeTauriCliVersion')
    expect(build).toContain('globalVersion === tauriCliVersion')
    expect(build).toContain('cachedVersion === tauriCliVersion')
    expect(build).toContain('macOS/Linux: bash scripts/build.sh')
  })

  it('runs real Windows mirror downloads and full clean-state client packaging in CI', () => {
    const workflow = read('.github/workflows/local-one-click-build.yml')

    expect(workflow).toContain('windows-node-bootstrap:')
    expect(workflow).toContain('mirror: [nodejs, npmmirror]')
    expect(workflow).toContain('bootstrap-node.ps1')
    expect(workflow).toContain('Get-FileHash -Algorithm SHA256')
    expect(workflow).toContain('one-click-client:')
    expect(workflow).toContain('os: [windows-latest, ubuntu-latest, macos-15-intel, macos-latest]')
    expect(workflow).toContain('win32-x64, linux-x64, darwin-x64, darwin-arm64')
    expect(workflow).toContain("HARNESSDOCK_FORCE_PORTABLE_NODE: '1'")
    expect(workflow).toContain('scripts\\build.bat --skip-tests')
    expect(workflow).toContain('bash scripts/build.sh --skip-tests')
    expect(workflow).not.toContain('run: ./scripts/build.sh --skip-tests')
    expect(workflow).toContain('Verify exact-pinned Runtime manifest')
    expect(workflow).toContain('Verify Windows NSIS installer')
    expect(workflow).toContain('Verify Linux bundle')
    expect(workflow).toContain('Verify macOS bundle')
  })
})
