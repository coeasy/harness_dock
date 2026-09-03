import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8')

describe('v0.2.0 repository hygiene contract', () => {
  it('contains no temporary v0.2.0 apply workflows or migration scripts', () => {
    const workflows = readdirSync(path.join(repoRoot, '.github/workflows'))
    expect(workflows.filter((name) => /^v020-.*apply.*\.ya?ml$/i.test(name))).toEqual([])

    const scripts = readdirSync(path.join(repoRoot, 'scripts'))
    expect(scripts.filter((name) => /^_apply-v020-/i.test(name))).toEqual([])
  })

  it('uses only the canonical Tauri icon preparation path in candidate builds', () => {
    const candidate = read('.github/workflows/tauri-candidate.yml')
    expect(candidate).toContain('run: pnpm prepare:icons')
    expect(candidate).not.toContain('cargo tauri icon src-tauri/icons/app-icon.png')
    expect(candidate).toContain('Verify Windows installer uses HarnessDock icon')
    expect(candidate).toContain('Prepare canonical HarnessDock launcher icons')
    expect(candidate).toContain('Prepare canonical HarnessDock app icons')
  })

  it('keeps Android candidate publication unsigned-compatible', () => {
    const candidate = read('.github/workflows/tauri-candidate.yml')
    for (const forbidden of ['ANDROID_KEY_', 'apksigner', 'jarsigner', 'configure-android-signing']) {
      expect(candidate).not.toContain(forbidden)
    }
    expect(candidate).toContain('cargo tauri android build --apk --aab')
    expect(candidate).toContain('node scripts/check-android-package.mjs')
  })
})
