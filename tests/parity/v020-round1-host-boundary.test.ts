import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')

describe('v0.2.0 Round 1 host boundaries', () => {
  it('keeps lib.rs as a composition root and moves desktop integration to the adapter', () => {
    const lib = read('apps/tauri/src-tauri/src/lib.rs')
    const desktop = read('apps/tauri/src-tauri/src/desktop.rs')

    expect(lib).toContain('mod desktop;')
    expect(lib).toContain('mod host_protocol;')
    expect(lib).toContain('.setup(desktop::setup)')
    expect(lib).toContain('app.run(desktop::handle_run_event)')
    expect(lib).not.toContain('fn install_shell_menu(')
    expect(lib).not.toContain('pub(crate) fn handle_run_event(')
    expect(desktop).toContain('fn install_shell_menu(')
    expect(desktop).toContain('pub(crate) fn handle_run_event(')
  })

  it('routes tray update intent through the shared workflow instead of calling updater directly', () => {
    const tray = read('apps/tauri/src-tauri/src/tray.rs')
    const workflow = read('apps/tauri/src-tauri/src/service/workflow.rs')
    const reconciler = read('apps/tauri/src-tauri/src/reconciler.rs')

    expect(tray).toContain('workflow::HostIntent::InstallUpdate')
    expect(tray).toContain('desktop::spawn_intent(app, intent)')
    expect(tray).not.toMatch(/=>\s*crate::update::update_install/)
    expect(workflow).toContain('HostCommand')
    expect(workflow).toContain('host_kernel::execute_native')
    expect(reconciler).toContain('HostCommand::InstallUpdate')
    expect(reconciler).toContain('crate::update::update_install(app)')
  })

  it('defines a typed Host Protocol v2 command envelope rather than string actions', () => {
    const protocol = `${read('apps/tauri/src-tauri/src/host_protocol.rs')}\n${read(
      'apps/tauri/src-tauri/src/host_protocol_generated.rs',
    )}`
    expect(protocol).toContain('pub const HOST_PROTOCOL_VERSION: u16 = 2')
    expect(protocol).toContain('pub enum HostCommand')
    expect(protocol).toContain('pub struct CommandEnvelope')
    expect(protocol).toContain('pub struct HostError')
    expect(protocol).toContain('pub struct HostSnapshot')
    expect(protocol).not.toContain('HashMap<String')
  })

  it('locks desktop distribution to a packaged Node+dsh Runtime with zero first-launch download', () => {
    const check = read('scripts/check-embedded-runtime.mjs')
    const runtimePackage = read('packages/client-runtime/package.json')
    const nodePrune = read('packages/client-runtime/src/node-runtime-prune.ts')
    const plan = read('docs/v0.2.0-architecture-five-round-final.md')

    expect(check).toContain('resource_path')
    expect(check).toContain('"dsh-runtime"')
    expect(check).toContain('first_launch_runtime_download_required')
    expect(runtimePackage).toContain('prune-node-cli.ts')
    expect(nodePrune).toContain("path.join('node_modules', 'npm')")
    expect(plan).toContain('首次启动不下载 Node 或 dsh')
    expect(plan).toContain('Immutable Embedded Runtime')
  })
})
