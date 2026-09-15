import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')

describe('native tray quit regression', () => {
  it('keeps exit independent from the serialized Host Kernel command queue', () => {
    const tray = read('apps/tauri/src-tauri/src/tray.rs')
    const quitStart = tray.indexOf('"tray-quit" => {')
    const fallbackStart = tray.indexOf('_ => None', quitStart)

    expect(quitStart).toBeGreaterThanOrEqual(0)
    expect(fallbackStart).toBeGreaterThan(quitStart)

    const quitArm = tray.slice(quitStart, fallbackStart)
    expect(quitArm).toContain('crate::request_exit(app);')
    expect(quitArm).toContain('lifecycle escape hatch')
    expect(quitArm).not.toContain('HostIntent::Quit')
    expect(tray).not.toContain('"tray-quit" => Some(workflow::HostIntent::Quit)')
  })
})
