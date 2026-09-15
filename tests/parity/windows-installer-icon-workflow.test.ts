import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) =>
  readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')

describe('Windows installer icon workflow regression guard', () => {
  it('passes the generated NSIS installer and canonical icon to the verifier', () => {
    const candidate = read('.github/workflows/tauri-candidate.yml')

    expect(candidate).toContain(
      "$installer = Get-ChildItem -Path apps/tauri/src-tauri/target/release/bundle/nsis -Filter '*setup.exe' | Select-Object -First 1",
    )
    expect(candidate).toContain("if (-not $installer) { throw 'Windows installer was not produced' }")
    expect(candidate).toContain(
      'node scripts/verify-windows-installer-icon.mjs $installer.FullName apps/tauri/src-tauri/icons/icon.ico',
    )
    expect(candidate).not.toContain('run: node scripts/verify-windows-installer-icon.mjs\n')
  })
})
