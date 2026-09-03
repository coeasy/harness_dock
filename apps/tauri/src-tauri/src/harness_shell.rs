//! Harness Web shell adapter.
//!
//! The UI is shipped as the independent `@dsh/plugin-harness-shell` dsh
//! plugin. Tauri supplies only minimum window primitives plus Host Protocol v2.
//! The remote Harness document never receives direct Runtime/update/quit IPC.

use tauri::Manager;

const SHELL_WEB_SCRIPT: &str =
    include_str!("../../../../packages/plugin-harness-shell/src/web/shell.js");

const BRIDGE_SCRIPT: &str = r#"
(() => {
  'use strict';
  const tauriInvoke = window.__TAURI__?.core?.invoke;
  const tauriListen = window.__TAURI__?.event?.listen;
  const directWindowMap = Object.freeze({
    'window.minimize': 'harness_minimize',
    'window.toggleMaximize': 'harness_toggle_maximize',
    'window.state': 'harness_window_state',
    'window.close': 'harness_shell_close'
  });
  const hostCommandMap = Object.freeze({
    'web.reload': 'refresh-harness',
    'web.restart': 'restart-runtime',
    'runtime.safe-mode': 'start-safe-mode',
    'runtime.clear-quarantine': 'clear-quarantine',
    'gateway.manage': 'show-gateway',
    'diagnostics.open': 'show-diagnostics'
  });
  const capabilities = Object.freeze(Object.fromEntries(
    [...Object.keys(directWindowMap), ...Object.keys(hostCommandMap)]
      .map((command) => [command, typeof tauriInvoke === 'function'])
  ));
  let requestSequence = 0;
  const requestId = () => {
    requestSequence += 1;
    const random = globalThis.crypto?.randomUUID?.();
    return random || `shell-${Date.now()}-${requestSequence}`;
  };
  const unwrapHostResponse = (response) => {
    if (response?.result?.Err) throw new Error(String(response.result.Err.message || 'Host command denied'));
    return response?.result?.Ok ?? response;
  };
  const invoke = (command, payload) => {
    if (typeof command !== 'string' || typeof tauriInvoke !== 'function') {
      return Promise.reject(new Error('外壳桥接不可用'));
    }
    if (Object.prototype.hasOwnProperty.call(directWindowMap, command)) {
      return tauriInvoke(directWindowMap[command], payload);
    }
    if (Object.prototype.hasOwnProperty.call(hostCommandMap, command)) {
      const envelope = {
        protocolVersion: 2,
        requestId: requestId(),
        subject: 'harness-web',
        command: { type: hostCommandMap[command] }
      };
      return tauriInvoke('host_execute', { envelope }).then(unwrapHostResponse);
    }
    return Promise.reject(new Error('外壳命令无效'));
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
    apiVersion: 2,
    pluginId: 'harness-shell',
    version: '0.2.0',
    capabilities,
    invoke,
    subscribe
  });
})();
"#;

/// The custom shell close button hides to tray only when a tray actually
/// exists. On desktops where tray creation failed, it performs supervised exit
/// so the Runtime/Gateway actors are still drained before process termination.
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
