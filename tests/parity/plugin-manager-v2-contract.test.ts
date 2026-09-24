import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) =>
  readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n')

describe('Plugin Manager V2 contract', () => {
  it('centralizes quarantine and recovery lifecycle', () => {
    const manager = read('apps/tauri/src-tauri/src/plugin_manager_v2.rs')
    const start = read('apps/tauri/src-tauri/src/runtime/start.rs')
    expect(manager).toContain('PluginLifecycleState')
    expect(manager).toContain('Quarantined')
    expect(manager).toContain('Recovering')
    expect(start).toContain('plugin_manager_v2::load_quarantine')
    expect(start).toContain('plugin_manager_v2::persist_quarantine')
  })

  it('binds quarantine to exact Runtime identity', () => {
    const quarantine = read('apps/tauri/src-tauri/src/plugin_quarantine.rs')
    expect(quarantine).toContain('const SCHEMA_VERSION: u8 = 4')
    expect(quarantine).toContain('runtime_image_identity')
    expect(quarantine).toContain('record.dsh_version == dsh_version')
    expect(quarantine).toContain('record.runtime_image_identity == runtime_image_identity')
  })
})
