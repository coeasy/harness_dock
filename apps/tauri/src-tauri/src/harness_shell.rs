//! Harness Web shell adapter.
//!
//! The UI is shipped as the independent `@dsh/plugin-harness-shell` dsh
//! plugin. Tauri only supplies the versioned host bridge here, so the same
//! shell asset can be published and installed independently by other dsh
//! hosts without copying Tauri-specific code into the Web application.

use tauri::Manager;

const SHELL_WEB_SCRIPT: &str =
    include_str!("../../../../packages/plugin-harness-shell/src/web/shell.js");

const BRIDGE_SCRIPT: &str = r#"
(() => {
  'use strict';
  const tauriInvoke = window.__TAURI__?.core?.invoke;
  const tauriListen = window.__TAURI__?.event?.listen;
  const commandMap = Object.freeze({
    'window.minimize': 'harness_minimize',
    'window.toggleMaximize': 'harness_toggle_maximize',
    'window.state': 'harness_window_state',
    'window.close': 'harness_shell_close',
    'web.reload': 'harness_reload_web',
    'web.restart': 'harness_restart_web',
    'runtime.safe-mode': 'harness_safe_mode_restart',
    'runtime.clear-quarantine': 'harness_clear_quarantine_restart',
    'gateway.manage': 'control_show',
    'diagnostics.open': 'shell_settings_show',
    'app.update.check': 'update_check',
    'app.update.install': 'update_install',
    'app.quit': 'app_quit'
  });
  const capabilities = Object.freeze(Object.fromEntries(
    Object.keys(commandMap).map((command) => [command, typeof tauriInvoke === 'function'])
  ));
  const invoke = (command, payload) => {
    if (typeof command !== 'string' || !Object.prototype.hasOwnProperty.call(commandMap, command)) {
      return Promise.reject(new Error('外壳命令无效'));
    }
    const nativeCommand = commandMap[command];
    if (!nativeCommand || typeof tauriInvoke !== 'function') {
      return Promise.reject(new Error('外壳桥接不可用'));
    }
    return tauriInvoke(nativeCommand, payload);
  };
  const subscribe = (listener) => {
    if (typeof tauriListen !== 'function' || typeof listener !== 'function') return () => {};
    let active = true;
    let unsubscribers = [];
    const stop = (unsubscribe) => {
      try {
        const result = unsubscribe();
        if (result && typeof result.catch === 'function') void result.catch(() => {});
      } catch (_) {}
    };
    const register = (eventName, map) => Promise.resolve()
      .then(() => tauriListen(eventName, (event) => listener(map(event?.payload))))
      .then((unsubscribe) => {
        if (typeof unsubscribe !== 'function') return;
        if (!active) {
          stop(unsubscribe);
          return;
        }
        unsubscribers.push(unsubscribe);
      })
      .catch(() => {});
    void register('harnessdock-shell-error', (payload) => ({ state: 'error', message: String(payload || '外壳操作失败') }));
    return () => {
      active = false;
      unsubscribers.splice(0).forEach(stop);
    };
  };
  window.__DSH_SHELL_BRIDGE__ = Object.freeze({
    apiVersion: 1,
    pluginId: 'harness-shell',
    version: '0.2.0',
    capabilities,
    invoke,
    subscribe
  });
})();
"#;

/// The custom shell close button hides to tray only when a tray actually
/// exists. On desktops where tray creation failed, hiding would strand an
/// invisible process because the normal ExitRequested guard intentionally
/// keeps the host alive during WebView transitions.
#[tauri::command]
pub async fn harness_shell_close(app: tauri::AppHandle) -> Result<(), String> {
    let tray_available = app
        .state::<crate::AppState>()
        .tray_available
        .load(std::sync::atomic::Ordering::Acquire);
    if tray_available {
        return crate::harness_window::harness_close(app).await;
    }
    crate::request_exit(&app);
    Ok(())
}

pub(crate) fn init_script() -> String {
    format!("{BRIDGE_SCRIPT}\n{SHELL_WEB_SCRIPT}")
}
