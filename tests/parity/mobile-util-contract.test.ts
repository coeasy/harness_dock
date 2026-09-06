import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')

describe('mobile shared utility boundary', () => {
  it('keeps loopback validation compiled for the mobile gateway', () => {
    const lib = read('apps/tauri/src-tauri/src/lib.rs')
    const gateway = read('apps/tauri/src-tauri/src/gateway.rs')
    const util = read('apps/tauri/src-tauri/src/util.rs')

    expect(gateway).toContain('use crate::util::is_loopback;')
    expect(util).toContain('pub(crate) fn is_loopback')
    expect(util).toContain('std::net::IpAddr')
    expect(lib).toMatch(/(?:^|\n)mod util;\n/)
    expect(lib).not.toMatch(/#\[cfg\(not\(mobile\)\)\]\nmod util;/)
  })
})
