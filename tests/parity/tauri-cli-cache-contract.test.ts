import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const action = readFileSync(
  path.join(repoRoot, '.github/actions/setup-tauri-cli/action.yml'),
  'utf8',
).replace(/\r\n/g, '\n')

describe('Tauri CLI cache contract', () => {
  it('separates hosted runner images so newer Linux binaries cannot poison older Linux runners', () => {
    expect(action).toContain('runner_image="${ImageOS:-}"')
    expect(action).toContain('linux-glibc-${libc_version:-unknown}')
    expect(action).toContain('echo "runner-image=$runner_image" >> "$GITHUB_OUTPUT"')
    expect(action).toContain(
      'key: harnessdock-tauri-cli-v2-${{ runner.os }}-${{ runner.arch }}-${{ steps.identity.outputs.runner-image }}-rust-${{ inputs.rust-toolchain }}-tauri-${{ steps.identity.outputs.version }}',
    )
    expect(action).not.toContain('restore-keys:')
  })

  it('validates a cache hit by execution and rebuilds the exact pinned CLI when the cache is unusable', () => {
    expect(action).toContain('verify_cli() {')
    expect(action).toContain('if ! "$binary" --version >"$output_file" 2>&1; then')
    expect(action).toContain('elif ! verify_cli; then')
    expect(action).toContain('Cached Tauri CLI is unusable on runner image')
    expect(action).toContain('cargo install tauri-cli')
    expect(action).toContain('--version "$TAURI_CLI_VERSION"')
    expect(action).toContain('--locked')
    expect(action).toContain('--root "$TAURI_CLI_ROOT"')
    expect(action).toContain('if ! verify_cli; then')
  })
})
