//! Harness Web shell adapter.
//!
//! The UI is shipped as the independent `@dsh/plugin-harness-shell` dsh
//! plugin. Tauri only supplies the versioned host bridge here, so the same
//! shell asset can be published and installed independently by other dsh
//! hosts without copying Tauri-specific code into the Web application.

const SHELL_WEB_SCRIPT: &str = include_str!("../../../../packages/plugin-harness-shell/src/web/shell.js");

const BRIDGE_SCRIPT: &str = r#"
(() => {
  'use strict';
  const tauriInvoke = window.__TAURI__?.core?.invoke;
  const tauriListen = window.__TAURI__?.event?.listen;
  const commandMap = Object.freeze({
    'window.minimize': 'harness_minimize',
    'window.toggleMaximize': 'harness_toggle_maximize',
    'window.state': 'harness_window_state',
    'window.close': 'harness_close',
    'web.reload': 'harness_reload_web',
    'web.restart': 'harness_restart_web',
    'runtime.safe-mode': 'harness_safe_mode_restart',
    'runtime.clear-quarantine': 'harness_clear_quarantine_restart',
    'diagnostics.open': 'shell_settings_show',
    'app.update.check': 'update_check',
    'app.update.install': 'update_install',
    'app.quit': 'app_quit'
  });
  const capabilities = Object.freeze(Object.fromEntries(
    Object.keys(commandMap).map((command) => [command, typeof tauriInvoke === 'function'])
  ));
  const invoke = (command, payload) => {
    const nativeCommand = commandMap[command];
    if (!nativeCommand || typeof tauriInvoke !== 'function') {
      return Promise.reject(new Error('外壳桥接不可用'));
    }
    return tauriInvoke(nativeCommand, payload);
  };
  const subscribe = (listener) => {
    if (typeof tauriListen !== 'function') return () => {};
    let unsubscribers = [];
    const register = (eventName, map) => Promise.resolve(tauriListen(eventName, (event) => listener(map(event?.payload))))
      .then((stop) => { if (typeof stop === 'function') unsubscribers.push(stop); })
      .catch(() => {});
    void Promise.all([
      register('harnessdock-shell-status', (payload) => payload),
      register('harnessdock-shell-error', (payload) => ({ state: 'error', message: String(payload || '外壳操作失败') }))
    ]);
    return () => { unsubscribers.splice(0).forEach((stop) => stop()); };
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

pub(crate) fn init_script() -> String {
    format!("{BRIDGE_SCRIPT}\n{SHELL_WEB_SCRIPT}")
}
