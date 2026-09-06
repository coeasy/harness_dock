//! Harness Web shell adapter.
//!
//! The UI is shipped as the independent `@dsh/plugin-harness-shell` dsh
//! plugin. Tauri supplies only minimum window primitives plus Host Protocol v2.
//! The remote Harness document never receives direct Runtime/update/quit IPC.

use crate::shell_contract_generated::{
    SHELL_API_VERSION, SHELL_DIRECT_WINDOW_MAP_JSON, SHELL_HOST_COMMAND_MAP_JSON,
    SHELL_PLUGIN_ID, SHELL_VERSION,
};
use tauri::Manager;

const SHELL_WEB_SCRIPT: &str =
    include_str!("../../../../packages/plugin-harness-shell/src/web/shell.js");

/// Web API compatibility layer, injected before every other page script.
const POLYFILL_SCRIPT: &str = r#"
(() => {
  'use strict';
  if (typeof Promise.withResolvers !== 'function') {
    Promise.withResolvers = function () {
      let resolve, reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };
  }
  if (typeof AbortSignal.any !== 'function') {
    const isAbortSignal = (value) =>
      typeof value === 'object' && value !== null &&
      'aborted' in value && typeof value.addEventListener === 'function';
    const readReason = (signal, fallback) => {
      try {
        const reason = signal.reason;
        return reason === undefined ? fallback : reason;
      } catch (_) {
        return fallback;
      }
    };
    const abortSignalWithReason = (signal, reason) => {
      if (signal.aborted) return;
      let safeReason = reason;
      try {
        safeReason = readReason(signal, new DOMException('The operation was aborted.', 'AbortError'));
      } catch (_) {}
      try {
        Object.defineProperty(signal, 'reason', { value: safeReason, configurable: true });
      } catch (_) {}
      try {
        signal.dispatchEvent(new Event('abort'));
      } catch (_) {}
    };
    AbortSignal.any = function (signals) {
      const result = new AbortController().signal;
      const live = [];
      let settled = false;
      const settle = (reason) => {
        if (settled) return;
        settled = true;
        abortSignalWithReason(result, reason);
        for (const signal of live) abortSignalWithReason(signal, reason);
        live.length = 0;
      };
      for (const value of signals) {
        if (!isAbortSignal(value)) continue;
        if (live.some((signal) => signal === value)) continue;
        if (value.aborted) {
          settle(readReason(value, undefined));
          continue;
        }
        const onAbort = () => settle(readReason(value, undefined));
        live.push(value);
        value.addEventListener('abort', onAbort, { once: true });
      }
      return result;
    };
  }
})();
"#;

const BRIDGE_SCRIPT_TEMPLATE: &str = r#"
(() => {
  'use strict';
  const tauriInvoke = window.__TAURI__?.core?.invoke;
  const tauriListen = window.__TAURI__?.event?.listen;
  const directWindowMap = Object.freeze(__DIRECT_WINDOW_MAP__);
  const hostCommandMap = Object.freeze(__HOST_COMMAND_MAP__);
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
    apiVersion: __SHELL_API_VERSION__,
    pluginId: __SHELL_PLUGIN_ID__,
    version: __SHELL_VERSION__,
    capabilities,
    invoke,
    subscribe
  });
})();
"#;

fn bridge_script() -> String {
    let plugin_id = serde_json::to_string(SHELL_PLUGIN_ID)
        .unwrap_or_else(|_| "\"harness-shell\"".to_string());
    let version = serde_json::to_string(SHELL_VERSION)
        .unwrap_or_else(|_| "\"0.1.2\"".to_string());
    BRIDGE_SCRIPT_TEMPLATE
        .replace("__DIRECT_WINDOW_MAP__", SHELL_DIRECT_WINDOW_MAP_JSON)
        .replace("__HOST_COMMAND_MAP__", SHELL_HOST_COMMAND_MAP_JSON)
        .replace("__SHELL_API_VERSION__", &SHELL_API_VERSION.to_string())
        .replace("__SHELL_PLUGIN_ID__", &plugin_id)
        .replace("__SHELL_VERSION__", &version)
}

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

/// Initialisation script order matters: polyfills first so that Tauri's own
/// `window.__TAURI__` bridge and dsh's client bundle both find the APIs they
/// call, then the host bridge, then the shell UI.
pub(crate) fn init_script() -> String {
    format!("{POLYFILL_SCRIPT}\n{}\n{SHELL_WEB_SCRIPT}", bridge_script())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_is_composed_from_generated_shell_contract() {
        let bridge = bridge_script();
        assert!(bridge.contains(&format!("apiVersion: {SHELL_API_VERSION}")));
        assert!(bridge.contains(SHELL_PLUGIN_ID));
        assert!(bridge.contains("window.minimize"));
        assert!(bridge.contains("diagnostics.open"));
        assert!(!bridge.contains("__SHELL_"));
        assert!(!bridge.contains("__DIRECT_WINDOW_MAP__"));
        assert!(!bridge.contains("__HOST_COMMAND_MAP__"));
    }
}
