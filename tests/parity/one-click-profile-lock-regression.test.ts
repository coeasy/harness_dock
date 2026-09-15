import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) =>
  readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')

describe('profile writer-lock packaged startup gates', () => {
  it('reproduces the real node_modules.lock failure on the PR one-click artifact before merge', () => {
    const oneClick = read('.github/workflows/local-one-click-build.yml')
    const smoke = read('scripts/smoke-windows-installer.ps1')

    const normal = oneClick.indexOf(
      './scripts/smoke-windows-installer.ps1 -InstallerPath $env:installer -TimeoutSeconds 120',
    )
    const contended = oneClick.indexOf(
      './scripts/smoke-windows-installer.ps1 -InstallerPath $env:installer -TimeoutSeconds 120 -BlockProfileWriter',
    )

    expect(normal).toBeGreaterThan(-1)
    expect(contended).toBeGreaterThan(normal)
    expect(oneClick).toContain(
      'Reinstall exact one-click artifact and prove private Rescue under profile writer-lock contention',
    )
    expect(smoke).toContain('[switch]$BlockProfileWriter')
    expect(smoke).toContain("HarnessDockProfileLockSmoke")
    expect(smoke).toContain('$env:DSH_HOME = $profileWriterHome')
    expect(smoke).toContain("Join-Path $profileDir 'node_modules.lock'")
    expect(smoke).toContain('Assert-PrivateRescueWasExercised')
    expect(smoke).toContain("-Filter 'rescue-dsh-home'")
    expect(smoke).toContain('atomic-write')
  })

  it('keeps the same fault injection in the post-candidate release gate', () => {
    const packaged = read('.github/workflows/windows-packaged-startup.yml')

    expect(packaged).toContain(
      'Prove packaged private Rescue startup under user profile writer-lock contention',
    )
    expect(packaged).toContain(
      './scripts/smoke-windows-installer.ps1 -InstallerPath $env:installer -TimeoutSeconds 120 -BlockProfileWriter',
    )
  })
})
