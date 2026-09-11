import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) =>
  readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')

describe('managed process lifecycle contract', () => {
  it('routes tray and window close through the supervised exit boundary', () => {
    const tray = read('apps/tauri/src-tauri/src/tray.rs')
    const desktop = read('apps/tauri/src-tauri/src/desktop.rs')
    const supervisor = read('apps/tauri/src-tauri/src/supervisor.rs')

    expect(tray).toContain('"tray-quit" => {')
    expect(tray).toContain('crate::request_exit(app);')
    expect(desktop).toContain('tauri::WindowEvent::CloseRequested')
    expect(desktop).toContain('crate::supervisor::request_exit(app_handle);')
    expect(desktop).toContain('tauri::RunEvent::Exit => {')
    expect(desktop).toContain('crate::supervisor::stop_managed_processes(app_handle);')
    expect(supervisor).toContain('state.quitting.swap(true, Ordering::SeqCst)')
    expect(supervisor).toContain('process::stop_starting_processes(&state.starting_processes)')
    expect(supervisor).toContain('gateway_host::stop_managed(&state.gateway)')
    expect(supervisor).toContain('runtime::stop_managed(&state.runtime_actor)')
    expect(supervisor).toContain('wait_for_managed_processes')
  })

  it('keeps refresh WebView-only and serializes restart as stop before start', () => {
    const reconciler = read('apps/tauri/src-tauri/src/reconciler.rs')
    const commands = read('apps/tauri/src-tauri/src/harness_window/commands.rs')
    const control = read('apps/tauri/src-tauri/src/runtime/control.rs')
    const surface = read('apps/tauri/src-tauri/src/surface_actor.rs')

    expect(reconciler).toContain(
      'HostCommand::RefreshHarness => crate::harness_window::harness_reload_web(app).await',
    )
    const refreshStart = commands.indexOf('pub async fn harness_reload_web')
    const restartStart = commands.indexOf('pub async fn harness_restart_web')
    expect(refreshStart).toBeGreaterThanOrEqual(0)
    expect(restartStart).toBeGreaterThan(refreshStart)
    const refreshBody = commands.slice(refreshStart, restartStart)
    expect(refreshBody).toMatch(/window\.(reload|navigate)\(/)
    expect(refreshBody).not.toMatch(/restart_managed|start_managed|spawn_runtime|Command::new/)

    const restart = control.indexOf('async fn restart_managed_mode')
    expect(restart).toBeGreaterThanOrEqual(0)
    const restartBody = control.slice(restart)
    expect(restartBody.indexOf('stop_impl(')).toBeGreaterThanOrEqual(0)
    expect(restartBody.indexOf('start_impl(')).toBeGreaterThan(restartBody.indexOf('stop_impl('))
    expect(restartBody).toContain('tauri::async_runtime::spawn_blocking')
    expect(surface).toContain('if self.operation != SurfaceOperation::Idle')
  })

  it('owns Runtime trees and reaps short-lived helper descendants', () => {
    const process = read('apps/tauri/src-tauri/src/process.rs')
    const platform = read('apps/tauri/src-tauri/src/platform.rs')
    const spawn = read('apps/tauri/src-tauri/src/runtime/spawn.rs')
    const runtimeTypes = read('apps/tauri/src-tauri/src/runtime/types.rs')

    expect(process).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE')
    expect(process).toContain('AssignProcessToJobObject')
    expect(process).toContain('TerminateJobObject')
    expect(platform).toContain('command.process_group(0)')
    expect(process).toContain('stop_process_group_after_parent_exit')
    expect(process).toContain('Err(poisoned) => poisoned.into_inner().is_empty()')
    expect(spawn).toContain('registration.terminate_descendants_after_parent_exit()')
    expect(runtimeTypes).toContain('self.registration.terminate_tree()')
    expect(runtimeTypes).toContain('process_control::stop_child_tree(&mut self.child)')
  })

  it('does not pin blocking-pool threads for watchdogs or Host Kernel replies', () => {
    const navigation = read('apps/tauri/src-tauri/src/harness_window/navigation.rs')
    const kernel = read('apps/tauri/src-tauri/src/host_kernel.rs')
    const cargo = read('apps/tauri/src-tauri/Cargo.toml')

    expect(navigation).toContain('tokio::time::sleep(std::time::Duration::from_secs(20)).await')
    expect(navigation).not.toContain('spawn_blocking(||')
    expect(kernel).toContain('tokio::sync::oneshot::channel()')
    expect(kernel).toContain('reply_rx.await')
    expect(kernel).not.toContain('spawn_blocking(move || reply_rx.recv())')
    expect(cargo).toContain('features = ["sync", "time"]')
  })

  it('keeps startup, refresh, restart and exit on dark compositor-safe surfaces', () => {
    const tauriConfig = JSON.parse(read('apps/tauri/src-tauri/tauri.conf.json'))
    const splashCss = read('apps/tauri/web/splash.css')
    const shell = read('apps/tauri/src-tauri/src/harness_shell.rs')
    const commands = read('apps/tauri/src-tauri/src/harness_window/commands.rs')
    const window = read('apps/tauri/src-tauri/src/harness_window/window.rs')
    const supervisor = read('apps/tauri/src-tauri/src/supervisor.rs')

    const splash = tauriConfig.app.windows.find((entry: { label?: string }) => entry.label === 'splash')
    expect(splash?.backgroundColor).toBe('#09111f')
    expect(splash?.theme).toBe('Dark')
    expect(splashCss).not.toContain('filter: blur(')
    expect(splashCss).not.toContain('filter: saturate(')

    expect(shell).toContain("const DARK = '#07101d';")
    expect(shell).toContain('window.__HARNESSDOCK_LIFECYCLE__ = Object.freeze')
    expect(shell).not.toContain('backdrop-filter')
    expect(window).toContain('.background_color(tauri::webview::Color(7, 16, 29, 255))')

    const refreshStart = commands.indexOf('pub async fn harness_reload_web')
    const restartCommandStart = commands.indexOf('pub async fn harness_restart_web')
    const refreshBody = commands.slice(refreshStart, restartCommandStart)
    expect(refreshBody).toContain('show_primary_lifecycle_overlay')
    expect(refreshBody).toContain('Duration::from_millis(48)')
    expect(refreshBody).not.toContain('show_splash(')

    const restartStart = window.indexOf('pub async fn restart_harness_web_impl')
    const restartBody = window.slice(restartStart)
    expect(restartBody).toContain('show_primary_lifecycle_overlay')
    expect(restartBody).toContain('harness_open_impl(app.clone(), url, false)')
    expect(restartBody).not.toContain('show_splash(')
    expect(restartBody).not.toContain('window.hide()')

    const exitStart = supervisor.indexOf('pub(crate) fn request_exit')
    const exitBody = supervisor.slice(exitStart)
    expect(exitBody).toContain('show_primary_lifecycle_overlay')
    expect(exitBody).toContain('Duration::from_millis(48)')
    expect(exitBody).not.toContain('show_splash(')

    expect(supervisor).toContain('async fn stop_managed_processes_blocking')
    expect(supervisor.match(/stop_managed_processes_blocking\(app\.clone\(\)\)\.await;/g)).toHaveLength(2)
    expect(supervisor.match(/stop_managed_processes\(&app\);/g)).toHaveLength(1)
  })

  it('proves the installed Windows client exits without bundled Node leftovers', () => {
    const smoke = read('scripts/smoke-windows-installer.ps1')
    const packaged = read('.github/workflows/windows-packaged-startup.yml')
    const localOneClick = read('.github/workflows/local-one-click-build.yml')

    expect(smoke).toContain("$runtimeNodes = @($managedBeforeExit | Where-Object { $_.Name -ieq 'node.exe' })")
    expect(smoke).toContain('$hostProcess.CloseMainWindow()')
    expect(smoke).toContain('Wait-InstalledProcessesGone $installDir 10')
    expect(smoke).toContain('graceful HarnessDock exit left zero installed Runtime/Node/Host processes')
    expect(packaged).toContain('./scripts/smoke-windows-installer.ps1 -InstallerPath $env:installer')
    expect(localOneClick).toContain('./scripts/smoke-windows-installer.ps1 -InstallerPath $env:installer')
  })
})
