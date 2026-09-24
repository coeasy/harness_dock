import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) =>
  readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n')

describe('Runtime Update V2 contract', () => {
  it('uses sealed A/B slots and rollback', () => {
    const source = read('apps/tauri/src-tauri/src/runtime_update_v2.rs')
    expect(source).toContain('RuntimeSlot')
    expect(source).toContain('slot-a')
    expect(source).toContain('slot-b')
    expect(source).toContain('image_identity')
    expect(source).toContain('expected_platform()')
    expect(source).toContain('expected_arch()')
    expect(source).toContain('RollingBack')
  })

  it('owns active Runtime image selection', () => {
    const paths = read('apps/tauri/src-tauri/src/runtime/paths.rs')
    expect(paths).toContain('runtime_update_v2::resolve_active_runtime_root')
  })
})
