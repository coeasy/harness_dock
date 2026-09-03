import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')

describe('v0.2.0 host-core architecture contract', () => {
  it('keeps the Tauri composition root free of lifecycle state ownership', () => {
    const lib = read('apps/tauri/src-tauri/src/lib.rs')
    expect(lib).toContain('mod lifecycle;')
    expect(lib).toContain('mod state;')
    expect(lib).toContain('mod supervisor;')
    expect(lib).toContain('mod startup_trace;')
    expect(lib).toContain('pub(crate) use state::AppState;')
    expect(lib).not.toContain('pub(crate) struct AppState {')
    expect(lib).not.toContain('fn wait_for_managed_processes(')
  })

  it('normalizes low-level flags through a typed lifecycle read model', () => {
    const lifecycle = read('apps/tauri/src-tauri/src/lifecycle.rs')
    expect(lifecycle).toContain('pub(crate) struct LifecycleSnapshot')
    expect(lifecycle).toContain('runtime_phase: RuntimePhase')
    expect(lifecycle).toContain('gateway_phase: GatewayPhase')
    expect(lifecycle).toContain('update_phase: UpdatePhase')
    expect(lifecycle).toContain('surface_operation: SurfaceOperation')
    expect(lifecycle).toContain('Restarting')
    expect(lifecycle).toContain('managed_operations_idle')
    expect(lifecycle).toContain('RuntimePhase::Cancelling')
  })

  it('routes cross-service shutdown through the supervisor', () => {
    const supervisor = read('apps/tauri/src-tauri/src/supervisor.rs')
    expect(supervisor).toContain('process::stop_starting_processes')
    expect(supervisor).toContain('gateway_host::stop_managed')
    expect(supervisor).toContain('runtime::stop_managed')
    expect(supervisor).toContain('lifecycle::snapshot')
    expect(supervisor).toContain('current.managed_operations_idle()')
  })

  it('keeps startup telemetry local, phase-only and fail-open', () => {
    const trace = read('apps/tauri/src-tauri/src/startup_trace.rs')
    expect(trace).toContain('startup-{}.log')
    expect(trace).toContain('phase={}')
    expect(trace).toContain('WRITTEN_PHASES')
    expect(trace).not.toContain('ready.url')
    expect(trace).not.toContain('admin_token')
    expect(trace).not.toContain('Authorization')
  })
})
