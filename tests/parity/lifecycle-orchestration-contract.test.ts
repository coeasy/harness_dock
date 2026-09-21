import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) =>
  readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n')

describe('production lifecycle orchestration contract', () => {
  it('binds RuntimeSupervisor events to RuntimeActor lifecycle', () => {
    const control = read('apps/tauri/src-tauri/src/runtime/control.rs')
    expect(control).toContain('RuntimeEvent::StartRequested(generation.id)')
    expect(control).toContain('RuntimeEvent::StartFailed(generation)')
    expect(control).toContain('RuntimeEvent::ProcessExited(generation)')
    expect(control).toContain('RuntimeEvent::Ready {')
    expect(control).toContain('RuntimeEvent::StopRequested')
    expect(control).toContain('RuntimeEvent::Stopped')
  })

  it('records first-boot startup from runtime through real WebView completion', () => {
    const startup = read('apps/tauri/src-tauri/src/startup.rs')
    const navigation = read('apps/tauri/src-tauri/src/harness_window/navigation.rs')
    const recovery = read('apps/tauri/src-tauri/src/harness_window/splash.rs')

    expect(startup).toContain('StartupEvent::RuntimeStarting')
    expect(startup).toContain('StartupEvent::RuntimeReady')
    expect(startup).toContain('StartupEvent::WebRequested')
    expect(navigation).toContain('StartupEvent::WebReady')
    expect(navigation).toContain('StartupEvent::Ready')
    expect(recovery).toContain('StartupEvent::Recovery')
  })

  it('routes real shutdown cleanup through ordered ShutdownManager events', () => {
    const supervisor = read('apps/tauri/src-tauri/src/supervisor.rs')
    for (const event of [
      'ShutdownEvent::Request',
      'ShutdownEvent::Freeze',
      'ShutdownEvent::StopPlugins',
      'ShutdownEvent::StopRuntime',
      'ShutdownEvent::CleanupProcesses',
      'ShutdownEvent::ReleaseResources',
      'ShutdownEvent::Complete { clean }',
    ]) {
      expect(supervisor).toContain(event)
    }
    expect(supervisor).toContain('process::starting_processes_empty')
    expect(supervisor).toContain('managed_operations_idle()')
  })

  it('exports diagnostics from the three real lifecycle state machines', () => {
    const diagnostics = read('apps/tauri/src-tauri/src/diagnostic_service.rs')
    expect(diagnostics).toContain('runtime.health().generation')
    expect(diagnostics).toContain('.metrics()')
    expect(diagnostics).toContain('.runtime_ready')
    expect(diagnostics).toContain('.web_ready')
    expect(diagnostics).toContain('.finished')
    expect(diagnostics).toContain('runtime_update.snapshot()')
    expect(diagnostics).toContain('plugins.snapshot()')
    expect(diagnostics).toContain('shutdown.report()')
    expect(diagnostics).toContain('shutdown_clean')
  })
})
