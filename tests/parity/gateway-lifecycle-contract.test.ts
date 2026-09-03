import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('Gateway lifecycle admission contract', () => {
  it('serializes explicit start and stop through the same atomic admission bit', () => {
    const source = readFileSync(
      path.join(repoRoot, 'apps/tauri/src-tauri/src/gateway_host.rs'),
      'utf8',
    )

    expect(source).toContain('fn claim_gateway_start')
    expect(source).toContain('fn claim_gateway_stop')
    expect(source).toContain('Arc::clone(&state.gateway_starting)')
    expect(source).toContain('lifecycle.swap(true, Ordering::AcqRel)')
    expect(source).toContain('let _stopping = claim_gateway_stop(&state)?;')
    expect(source).not.toContain('if state.gateway_starting.load(Ordering::Acquire) {\n        return Err("Gateway 正在启动，请稍候再停止。"')
  })
})
