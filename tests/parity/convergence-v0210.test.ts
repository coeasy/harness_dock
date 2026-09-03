import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), 'utf8')
const readJson = (relative: string): Record<string, any> => JSON.parse(read(relative))

describe('v0.2.10 Tauri convergence gates', () => {
  it('keeps public desktop entrypoints on Tauri rather than Electron packaging', () => {
    const root = readJson('package.json')
    const scripts = root.scripts as Record<string, string>
    expect(scripts['pack:desktop']).toBeUndefined()
    expect(scripts['pack:desktop:win']).toBeUndefined()
    expect(scripts['pack:desktop:mac']).toBeUndefined()
    expect(scripts['pack:desktop:linux']).toBeUndefined()
    expect(scripts['start:desktop']).toBeUndefined()
    expect(scripts['build:desktop']).toBeUndefined()

    const candidate = read('.github/workflows/tauri-candidate.yml')
    const release = read('.github/workflows/release.yml')
    expect(candidate).toContain('cargo tauri build')
    expect(candidate).not.toContain('electron-builder')
    expect(release).toContain('tauri-candidate')
    expect(release).not.toContain('electron-builder')
  })

  it('serializes Gateway startup and rejects stale lifecycle results', () => {
    const host = read('apps/tauri/src-tauri/src/lib.rs')
    const gateway = read('apps/tauri/src-tauri/src/gateway_host.rs')
    expect(host).toContain('gateway_starting: AtomicBool')
    expect(host).toContain('gateway_generation: AtomicU64')
    expect(gateway).toContain('GatewayStartGuard')
    expect(gateway).toContain('state.gateway_starting.swap(true')
    expect(gateway).toContain('state.gateway_generation.load')
    expect(gateway).toContain('state.gateway_generation.fetch_add')
    expect(gateway).toContain('runtime_still_matches')
  })

  it('invalidates Gateway ownership whenever the public Runtime stop command runs', () => {
    const host = read('apps/tauri/src-tauri/src/lib.rs')
    const start = host.indexOf('fn runtime_stop(')
    const end = host.indexOf('#[cfg(not(mobile))]', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const command = host.slice(start, end)
    expect(command).toContain('gateway_generation.fetch_add')
    expect(command).toContain('gateway_host::stop_managed(&state.gateway)')
    expect(command).toContain('runtime::runtime_stop(state)')
    expect(host).toContain('runtime_stop,')
  })

  it('detects dead Gateway children and binds ready metadata to the managed PID', () => {
    const gateway = read('apps/tauri/src-tauri/src/gateway_host.rs')
    expect(gateway).toContain('fn is_alive(&mut self) -> bool')
    expect(gateway).toContain('!process.is_alive()')
    expect(gateway).toContain('ready.pid != child.id()')
  })

  it('uses graceful bounded process shutdown before forced tree termination', () => {
    const process = read('apps/tauri/src-tauri/src/process.rs')
    expect(process).toContain('graceful_stop_process_tree(pid)')
    expect(process).toContain('Duration::from_secs(2)')
    expect(process).toContain('force_stop_process_tree(pid)')
    expect(process).toContain('taskkill')
    expect(process).toContain('-TERM')
    expect(process).toContain('-KILL')
  })

  it('serializes VS Code runtime start/stop and discards stale startup results', () => {
    const extension = read('apps/vscode/src/extension.ts')
    expect(extension).toContain('let runtimeStart: Promise<BootstrapResult | undefined> | undefined')
    expect(extension).toContain('let runtimeStop: Promise<void> | undefined')
    expect(extension).toContain('let runtimeGeneration = 0')
    expect(extension).toContain('if (runtimeStart) return runtimeStart')
    expect(extension).toContain('if (generation !== runtimeGeneration)')
    expect(extension).toContain('runtimeGeneration += 1')
    expect(extension).toContain('const starting = runtimeStart')
    expect(extension).toContain('await result.runtime.stop()')
  })

  it('fails closed instead of treating malformed release versions as updates', () => {
    const update = read('apps/tauri/src-tauri/src/update.rs')
    expect(update).toContain("split(['-', '+'])")
    expect(update).toContain('if parts.next().is_some()')
    expect(update).toContain('_ => false')
    expect(update).not.toContain('normalized_version(latest) != normalized_version(current)')
  })

  it('keeps all release-facing versions and runtime bundle URLs on v0.2.10', () => {
    const root = readJson('package.json')
    const tauri = readJson('apps/tauri/src-tauri/tauri.conf.json')
    const origin = readJson('packages/docs-sync/origin.json')
    expect(root.version).toBe('0.2.10')
    expect(tauri.version).toBe(root.version)
    expect(origin.clientVersion).toBe(root.version)
    for (const bundle of Object.values(origin.runtimeBundles as Record<string, { url: string }>)) {
      expect(bundle.url).toContain('/releases/download/v0.2.10/')
    }
  })
})
