import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string) =>
  readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n/g, '\n')

describe('desktop interaction feedback contract', () => {
  it('paints the startup surface immediately and keeps it until Harness claims primary_visible', () => {
    const config = JSON.parse(read('apps/tauri/src-tauri/tauri.conf.json'))
    const splash = config.app.windows.find((window: { label?: string }) => window.label === 'splash')
    expect(splash?.visible).toBe(true)

    const startup = read('apps/tauri/src-tauri/src/startup.rs')
    expect(startup).toContain('show_splash(&app, "正在启动 Harness Runtime…")')
    expect(startup).toContain('set_splash_status(&app, "Runtime 已就绪，正在准备 Harness Web…")')
    expect(startup).toContain('set_splash_status(&app, "正在打开 Harness Web…")')

    const commands = read('apps/tauri/src-tauri/src/harness_window/commands.rs')
    const startupOpen = commands.slice(
      commands.indexOf('pub(crate) async fn open_for_startup'),
      commands.indexOf('#[tauri::command]\npub async fn harness_close'),
    )
    expect(startupOpen).toContain('harness_open_impl(app, url, true).await')

    const navigation = read('apps/tauri/src-tauri/src/harness_window/navigation.rs')
    expect(navigation).toContain('hide_splash(&app);')
    expect(navigation).toContain('StartupPhase::PrimaryVisible')
  })

  it('acknowledges supervised quit before waiting for managed processes', () => {
    const supervisor = read('apps/tauri/src-tauri/src/supervisor.rs')
    expect(supervisor).toContain('show_splash(app, "正在安全退出 HarnessDock…")')
    expect(supervisor).toContain('正在关闭 Runtime、Gateway 与后台任务…')
    expect(supervisor).toContain('正在等待受管进程安全退出…')
    expect(supervisor).toContain('正在完成退出…')
  })

  it('makes every primary close path mean supervised exit regardless of tray availability', () => {
    const shellHost = read('apps/tauri/src-tauri/src/harness_shell.rs')
    const closeCommand = shellHost.slice(
      shellHost.indexOf('pub async fn harness_shell_close'),
      shellHost.indexOf('/// Initialisation script order matters'),
    )
    expect(closeCommand).toContain('crate::request_exit(&app);')
    expect(closeCommand).not.toContain('tray_available')
    expect(closeCommand).not.toContain('harness_close(app)')

    const desktop = read('apps/tauri/src-tauri/src/desktop.rs')
    const nativeClose = desktop.slice(
      desktop.indexOf('event: tauri::WindowEvent::CloseRequested'),
      desktop.indexOf('event: tauri::WindowEvent::Destroyed'),
    )
    expect(nativeClose).toContain('api.prevent_close();')
    expect(nativeClose).toContain('crate::supervisor::request_exit(app_handle);')
    expect(nativeClose).not.toContain('tray_available')
    expect(nativeClose).not.toContain('window.hide()')
  })

  it('keeps motion optional and explains a prolonged startup without weakening timeouts', () => {
    const html = read('apps/tauri/web/splash.html')
    const css = read('apps/tauri/web/splash.css')
    const js = read('apps/tauri/web/splash.js')

    expect(html).toContain('data-state="loading"')
    expect(html).toContain('id="splash-status"')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('html[data-state="exiting"]')
    expect(js).toContain("document.documentElement.dataset.state = state")
    expect(js).toContain("state === 'exiting'")
    expect(js).toContain('scheduleLongWaitHint(state)')
    expect(js).toContain('}, 8000)')
    expect(js).toContain('无需重复点击或重新启动')
  })

  it('keeps the independent Harness Shell source and shipped web artifact identical', () => {
    const source = read('packages/plugin-harness-shell/src/web/shell.js')
    const shipped = read('packages/plugin-harness-shell/web/shell.js')
    expect(shipped).toBe(source)

    expect(source).toContain('data-activity')
    expect(source).toContain('activity-run')
    expect(source).toContain('@media (prefers-reduced-motion: reduce)')
    expect(source).toContain("shadow.querySelectorAll('.bar [data-action]')")
    expect(source).toContain("menuToggle?.setAttribute('aria-expanded'")
  })

  it('provides keyboard-complete shell menus and a nonblank reload/restart transition', () => {
    const source = read('packages/plugin-harness-shell/src/web/shell.js')
    expect(source).toContain('transition-mask')
    expect(source).toContain('transitionStatus')
    expect(source).toContain("event.key === 'ArrowDown'")
    expect(source).toContain("event.key === 'ArrowUp'")
    expect(source).toContain("event.key === 'Home'")
    expect(source).toContain("event.key === 'End'")
    expect(source).toContain('closeMenu(true)')
    expect(source).toContain('退出 HarnessDock')
  })

  it('does not propagate AbortSignal.any cancellation back into source signals', () => {
    const shellHost = read('apps/tauri/src-tauri/src/harness_shell.rs')
    expect(shellHost).toContain('const controller = new AbortController();')
    expect(shellHost).toContain('controller.abort(reason);')
    expect(shellHost).toContain("signal.removeEventListener('abort', listener)")
    expect(shellHost).not.toContain("signal.dispatchEvent(new Event('abort'))")
    expect(shellHost).not.toContain('for (const signal of live)')
  })

  it('coalesces control focus refreshes and prevents conflicting lifecycle actions', () => {
    const app = read('apps/tauri/web/app.js')
    const styles = read('apps/tauri/web/styles.css')
    expect(app).toContain('refreshInFlight')
    expect(app).toContain('refreshAgain')
    expect(app).toContain('scheduleVisibleRefresh')
    expect(app).toContain('operationGroups')
    expect(app).toContain("'runtime-lifecycle'")
    expect(app).toContain("'gateway-admin'")
    expect(app).toContain('const operationBusy = new Map()')
    expect(app).toContain('const active = element === activeElement')
    expect(app).toContain('withOperation')
    expect(styles).toContain('.actions button.is-busy')
    expect(styles).toContain('.device button.is-busy')
  })

  it('uses nonblocking second-click confirmation and keeps results visible across background refreshes', () => {
    const app = read('apps/tauri/web/app.js')
    const styles = read('apps/tauri/web/styles.css')
    expect(app).not.toContain('window.confirm')
    expect(app).toContain('confirmSecondClick')
    expect(app).toContain('confirmations')
    expect(app).toContain('statusHoldUntil')
    expect(app).toContain('now + 4800')
    expect(app).toContain('now + 1800')
    expect(styles).toContain('button.confirming')
  })

  it('keeps continuous control feedback compositor-friendly and motion-optional', () => {
    const styles = read('apps/tauri/web/styles.css')
    expect(styles).toContain('will-change:transform,opacity')
    expect(styles).toContain('@keyframes boot-pulse{0%{opacity:.45;transform:scale(1)}')
    expect(styles).toContain('@keyframes confirm-pulse{0%,100%{opacity:1}')
    expect(styles).not.toContain('@keyframes boot-pulse{0%{box-shadow')
    expect(styles).not.toContain('@keyframes confirm-pulse{0%,100%{box-shadow')
    expect(styles).toContain('@media (prefers-reduced-motion:reduce)')
  })

  it('coalesces diagnostics event bursts instead of repainting for every HostEvent', () => {
    const settings = read('apps/tauri/web/settings.js')
    const styles = read('apps/tauri/web/styles.css')
    expect(settings).toContain('snapshotRefreshPromise')
    expect(settings).toContain('snapshotRefreshPending')
    expect(settings).toContain('queueEventRefresh')
    expect(settings).toContain('void refresh(false)')
    expect(settings).toContain("button.classList.toggle('is-busy', busy)")
    expect(settings).toContain("button.setAttribute('aria-busy', String(busy))")
    expect(styles).toContain('.settings-page button.is-busy')
    expect(styles).toContain('@media (prefers-reduced-motion:reduce)')
  })

  it('restores tool-generated Cargo metadata before judging one-click checkout cleanliness', () => {
    const workflow = read('.github/workflows/local-one-click-build.yml')
    expect(workflow).toContain("'apps/tauri/src-tauri/Cargo.lock'")
    expect(workflow).toContain('git restore --source=HEAD -- $generatedBuildOutputs')
    expect(workflow).toContain('git restore --source=HEAD -- "${generated_build_outputs[@]}"')
  })
})