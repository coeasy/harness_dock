//! Harness Web shell adapter.
//!
//! The UI is shipped as the independent `@dsh/plugin-harness-shell` dsh
//! plugin. Tauri supplies only minimum window primitives plus Host Protocol v2.
//! The remote Harness document never receives direct Runtime/update/quit IPC.

const SHELL_WEB_SCRIPT: &str =
    include_str!("../../../../packages/plugin-harness-shell/src/web/shell.js");

/// Web API compatibility layer, injected before every other page script.
///
/// HarnessDock ships against the WebView2 Runtime that is already present on
/// the host machine. Older Evergreen runtimes (observed: Chromium 113) lack
/// the Web APIs dsh's client bundle relies on, so a missing API degrades the
/// whole document instead of one feature:
///
/// * `Promise.withResolvers` is used by Tauri's own `window.__TAURI__` bridge
///   script. When it throws, the shell bridge is installed only partially.
/// * `AbortSignal.any` is used by dsh's `RemoteStream.read` control stream.
///   When it throws, the session controller cannot establish a stream, the
///   connection client backs off forever, and the Settings chrome stays on
///   "connecting" while the browser console is filled with TypeErrors.
///
/// This pre-document script also establishes the dark first-paint contract and
/// a tiny compositor-friendly lifecycle surface. Once Harness Web is visible,
/// refresh/restart/quit feedback stays inside this already-painted WebView so a
/// hidden splash WebView never has to be reactivated during process work.
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
    AbortSignal.any = function (signals) {
      const controller = new AbortController();
      const listeners = [];
      let settled = false;
      const cleanup = () => {
        for (const [signal, listener] of listeners) {
          try { signal.removeEventListener('abort', listener); } catch (_) {}
        }
        listeners.length = 0;
      };
      const settle = (reason) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          controller.abort(reason);
        } catch (_) {
          controller.abort();
        }
      };
      for (const value of signals) {
        if (!isAbortSignal(value)) continue;
        if (listeners.some(([signal]) => signal === value)) continue;
        if (value.aborted) {
          settle(readReason(value, undefined));
          break;
        }
        const onAbort = () => settle(readReason(value, undefined));
        listeners.push([value, onAbort]);
        value.addEventListener('abort', onAbort, { once: true });
      }
      return controller.signal;
    };
  }

  const DARK = '#07101d';
  const installFirstPaint = () => {
    const root = document.documentElement;
    if (!root) return;
    root.style.backgroundColor = DARK;
    root.style.colorScheme = 'dark';
  };
  installFirstPaint();

  const lifecycle = (() => {
    let host = null;
    let status = null;
    const ensure = () => {
      installFirstPaint();
      if (host?.isConnected) return host;
      const root = document.documentElement;
      if (!root) return null;
      host = document.createElement('div');
      host.id = 'harnessdock-lifecycle-surface';
      host.setAttribute('aria-live', 'polite');
      host.setAttribute('aria-busy', 'true');
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `
        :host { all: initial; color-scheme: dark; }
        .surface { align-items: center; background: rgba(7,16,29,.965); display: flex; inset: 0; justify-content: center; opacity: 0; pointer-events: all; position: fixed; transform: translateZ(0); transition: opacity .14s ease; visibility: hidden; z-index: 2147483646; }
        .surface.show { opacity: 1; visibility: visible; }
        .card { align-items: center; background: rgba(17,28,44,.94); border: 1px solid rgba(255,255,255,.12); border-radius: 14px; box-shadow: 0 14px 42px rgba(0,0,0,.28); color: #dce8f6; display: flex; font: 12px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; gap: 11px; max-width: min(420px, calc(100vw - 48px)); padding: 12px 16px; transform: translateY(3px) scale(.99); transition: transform .16s cubic-bezier(.2,.8,.2,1); }
        .surface.show .card { transform: translateY(0) scale(1); }
        .spinner { border: 2px solid rgba(125,211,252,.2); border-radius: 50%; border-top-color: #5eead4; flex: 0 0 auto; height: 17px; width: 17px; animation: spin .82s linear infinite; }
        .surface[data-mode="exit"] .spinner { border-top-color: #7dd3fc; animation-duration: 1.05s; }
        .text { overflow-wrap: anywhere; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .surface, .card { transition-duration: .01ms; } .spinner { animation: none; border-top-color: #5eead4; } }
      `;
      const surface = document.createElement('div');
      surface.className = 'surface';
      surface.innerHTML = '<div class="card"><span class="spinner" aria-hidden="true"></span><span class="text"></span></div>';
      status = surface.querySelector('.text');
      shadow.append(style, surface);
      root.appendChild(host);
      return host;
    };
    const surface = () => {
      const current = ensure();
      return current ? current.shadowRoot?.querySelector?.('.surface') : null;
    };
    // Closed shadow roots are intentionally not externally reachable. Keep the
    // actual surface element in a private closure instead of exposing DOM state.
    let surfaceNode = null;
    const ensureSurface = () => {
      installFirstPaint();
      if (host?.isConnected && surfaceNode) return surfaceNode;
      const root = document.documentElement;
      if (!root) return null;
      host = document.createElement('div');
      host.id = 'harnessdock-lifecycle-surface';
      host.setAttribute('aria-live', 'polite');
      host.setAttribute('aria-busy', 'true');
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `
        :host { all: initial; color-scheme: dark; }
        .surface { align-items: center; background: rgba(7,16,29,.965); display: flex; inset: 0; justify-content: center; opacity: 0; pointer-events: all; position: fixed; transform: translateZ(0); transition: opacity .14s ease; visibility: hidden; z-index: 2147483646; }
        .surface.show { opacity: 1; visibility: visible; }
        .card { align-items: center; background: rgba(17,28,44,.94); border: 1px solid rgba(255,255,255,.12); border-radius: 14px; box-shadow: 0 14px 42px rgba(0,0,0,.28); color: #dce8f6; display: flex; font: 12px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; gap: 11px; max-width: min(420px, calc(100vw - 48px)); padding: 12px 16px; transform: translateY(3px) scale(.99); transition: transform .16s cubic-bezier(.2,.8,.2,1); }
        .surface.show .card { transform: translateY(0) scale(1); }
        .spinner { border: 2px solid rgba(125,211,252,.2); border-radius: 50%; border-top-color: #5eead4; flex: 0 0 auto; height: 17px; width: 17px; animation: spin .82s linear infinite; }
        .surface[data-mode="exit"] .spinner { border-top-color: #7dd3fc; animation-duration: 1.05s; }
        .text { overflow-wrap: anywhere; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .surface, .card { transition-duration: .01ms; } .spinner { animation: none; border-top-color: #5eead4; } }
      `;
      surfaceNode = document.createElement('div');
      surfaceNode.className = 'surface';
      const card = document.createElement('div');
      card.className = 'card';
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      spinner.setAttribute('aria-hidden', 'true');
      status = document.createElement('span');
      status.className = 'text';
      card.append(spinner, status);
      surfaceNode.appendChild(card);
      shadow.append(style, surfaceNode);
      root.appendChild(host);
      return surfaceNode;
    };
    return Object.freeze({
      show(message, mode = 'work') {
        const node = ensureSurface();
        if (!node) return false;
        if (status) status.textContent = String(message || '正在处理…');
        node.dataset.mode = String(mode || 'work');
        node.classList.add('show');
        return true;
      },
      update(message) {
        if (status) status.textContent = String(message || '正在处理…');
      },
      hide() {
        surfaceNode?.classList.remove('show');
      }
    });
  })();
  window.__HARNESSDOCK_LIFECYCLE__ = lifecycle;
})();
"#;

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
  // This map is exactly the set of commands `capability_broker.rs` allows for
  // the HarnessWeb subject. Commands the broker denies to web
  // (RuntimeQuarantineAdmin, UpdateInstall, AppQuit, ...) are reachable from
  // the native tray and diagnostics surfaces instead — they are deliberately
  // absent here and from SHELL_COMMANDS, so the web contract can never
  // advertise a command the broker is bound to reject.
  // tests/parity/shell-contract-lockstep.test.ts enforces the three-way
  // agreement between this map, SHELL_COMMANDS and the broker allow-list.
  const hostCommandMap = Object.freeze({
    'web.reload': 'refresh-harness',
    'web.restart': 'restart-runtime',
    'runtime.safe-mode': 'start-safe-mode',
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

/// The shell close button always means exit. Hiding to tray is intentionally a
/// separate native action so the top-right X never leaves Runtime/Gateway work
/// alive after the user believes the application has closed.
#[tauri::command]
pub async fn harness_shell_close(app: tauri::AppHandle) -> Result<(), String> {
    crate::request_exit(&app);
    Ok(())
}

/// Initialisation script order matters: polyfills first so that Tauri's own
/// `window.__TAURI__` bridge and dsh's client bundle both find the APIs they
/// call, then the host bridge, then the shell UI.
pub(crate) fn init_script() -> String {
    format!("{POLYFILL_SCRIPT}\n{BRIDGE_SCRIPT}\n{SHELL_WEB_SCRIPT}")
}
