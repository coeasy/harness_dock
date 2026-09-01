/// Minimal shell bridge injected into the loopback Harness WebView.
///
/// The official Harness UI stays the primary application surface. This script
/// adds safe, local-only controls for the separate Shell Settings plugin window and
/// the Harness window lifecycle; it never starts Runtime, changes DSH configuration,
/// or exposes remote host controls. The settings window is prepared hidden during host setup and
/// shown only after an explicit click.
pub(crate) const INIT_SCRIPT: &str = r##"
(() => {
  'use strict';

  const isLoopback = () => {
    const host = String(window.location.hostname || '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  };

  if (!isLoopback()) return;

  const invoke = () => window.__TAURI__?.core?.invoke;
  let toastTimer;
  const notify = (value, bad = true) => {
    const toast = document.getElementById('harnessdock-shell-toast');
    if (!toast) return;
    toast.textContent = String(value?.message || value || '操作失败');
    toast.dataset.bad = bad ? 'true' : 'false';
    toast.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 4200);
  };

  const run = async (command, button) => {
    const call = invoke();
    if (typeof call !== 'function') {
      notify('外壳 IPC 尚未就绪，请稍后重试。');
      return undefined;
    }
    if (button) {
      button.setAttribute('aria-busy', 'true');
      button.disabled = true;
    }
    try {
      return await call(command);
    } catch (error) {
      notify(error);
      return undefined;
    } finally {
      if (button) {
        button.removeAttribute('aria-busy');
        button.disabled = false;
      }
    }
  };

  const install = () => {
    if (!document.documentElement || document.getElementById('harnessdock-shell')) return;

    const style = document.createElement('style');
    style.id = 'harnessdock-shell-style';
    style.textContent = [
      '#harnessdock-shell{position:fixed;top:0;left:0;right:0;height:38px;z-index:2147483647;display:flex;align-items:center;justify-content:space-between;padding:0 10px 0 16px;background:linear-gradient(180deg,rgba(18,31,51,.98),rgba(9,18,32,.98));border-bottom:1px solid rgba(148,178,214,.18);box-shadow:0 1px 0 rgba(0,0,0,.28);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;user-select:none;-webkit-user-select:none}',
      '#harnessdock-shell .harnessdock-shell-drag{display:flex;align-items:center;min-width:0;flex:1;height:100%;-webkit-app-region:drag}',
      '#harnessdock-shell .harnessdock-shell-brand{display:flex;align-items:center;gap:8px;color:#e9eef7;font-size:12px;font-weight:700;letter-spacing:.03em}',
      '#harnessdock-shell .harnessdock-shell-mark{width:16px;height:16px;border-radius:5px;background:radial-gradient(circle at 35% 30%,#6ee7d8 0%,#14b8a6 58%,#0d9488 100%);box-shadow:0 0 8px rgba(20,184,166,.42),inset 0 0 0 1px rgba(255,255,255,.18)}',
      '#harnessdock-shell .harnessdock-shell-mark:after{content:"";display:block;width:7px;height:7px;margin:4.5px;border-radius:50%;background:#d9fff6;box-shadow:0 0 5px rgba(126,231,214,.6)}',
      '#harnessdock-shell .harnessdock-shell-actions{display:flex;align-items:center;gap:4px;height:100%;-webkit-app-region:no-drag}',
      '#harnessdock-shell button{all:unset;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;min-width:30px;padding:0 9px;border-radius:8px;color:#c7d5e8;font-size:12px;font-weight:650;cursor:pointer;background:rgba(148,178,214,.1);border:1px solid rgba(148,178,214,.18);box-sizing:border-box;-webkit-app-region:no-drag}',
      '#harnessdock-shell .harnessdock-shell-settings{min-width:0}',
      '#harnessdock-shell .harnessdock-shell-window-control{padding:0;background:transparent;border-color:transparent}',
      '#harnessdock-shell button:hover{background:rgba(45,212,191,.16);color:#eafffb;border-color:rgba(45,212,191,.42)}',
      '#harnessdock-shell .harnessdock-shell-close:hover{background:rgba(248,113,113,.2);color:#fecaca;border-color:rgba(248,113,113,.42)}',
      '#harnessdock-shell button:active{transform:scale(.97)}',
      '#harnessdock-shell button[aria-busy="true"]{opacity:.55;cursor:wait}',
      '#harnessdock-shell button:focus-visible{outline:2px solid #5eead4;outline-offset:1px}',
      '#harnessdock-shell svg{width:13px;height:13px;flex:0 0 13px}',
      '#harnessdock-shell .harnessdock-shell-separator{width:1px;height:18px;background:rgba(148,178,214,.22);margin:0 3px}',
      '#harnessdock-shell-toast{position:fixed;top:48px;right:12px;max-width:min(360px,calc(100vw - 24px));padding:9px 12px;border:1px solid rgba(248,113,113,.45);border-radius:10px;background:rgba(49,19,28,.96);color:#fecaca;font-size:12px;line-height:1.45;opacity:0;transform:translateY(-4px);pointer-events:none;transition:opacity .18s ease,transform .18s ease}',
      '#harnessdock-shell-toast.is-visible{opacity:1;transform:translateY(0)}',
      'html body{padding-top:38px!important}'
    ].join('');
    document.documentElement.appendChild(style);

    const bar = document.createElement('div');
    bar.id = 'harnessdock-shell';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'HarnessDock 外壳');
    bar.innerHTML = '<div class="harnessdock-shell-drag"><div class="harnessdock-shell-brand"><span class="harnessdock-shell-mark" aria-hidden="true"></span><span>HarnessDock</span></div></div><div class="harnessdock-shell-actions"><button id="harnessdock-shell-settings-button" class="harnessdock-shell-settings" type="button" title="打开外壳设置" aria-label="打开外壳设置"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Zm8.1 3.8c0-.5-.1-1-.2-1.4l-2-1.5 2-3.4-2.3-.9c-.7-.6-1.5-1-2.4-1.3L14.8 3h-4l-.4 2.3c-.9.3-1.7.7-2.4 1.3l-2.3-.9-2 3.4 2 1.5c-.1.5-.2 1-.2 1.4s.1 1 .2 1.4l-2 1.5 2 3.4 2.3-.9c.7.6 1.5 1 2.4 1.3l.4 2.3c.9.3 1.7.7 2.4 1.3l2.3-.9 2 3.4-2 1.5c.1.4.2.9.2 1.4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg><span>设置</span></button><span class="harnessdock-shell-separator" aria-hidden="true"></span><button id="harnessdock-shell-minimize" class="harnessdock-shell-window-control" type="button" title="最小化" aria-label="最小化"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button><button id="harnessdock-shell-maximize" class="harnessdock-shell-window-control" type="button" title="最大化" aria-label="最大化"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button><button id="harnessdock-shell-close" class="harnessdock-shell-window-control harnessdock-shell-close" type="button" title="隐藏到托盘" aria-label="隐藏到托盘"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></div><div id="harnessdock-shell-toast" role="status" aria-live="polite"></div>';
    document.documentElement.appendChild(bar);

    document.getElementById('harnessdock-shell-settings-button')?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void run('shell_settings_show', event.currentTarget);
    });
    document.getElementById('harnessdock-shell-minimize')?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void run('harness_minimize', event.currentTarget);
    });
    document.getElementById('harnessdock-shell-maximize')?.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const button = event.currentTarget;
      const state = await run('harness_toggle_maximize', button);
      if (state) {
        const maximized = Boolean(state.maximized);
        button.title = maximized ? '还原' : '最大化';
        button.setAttribute('aria-label', maximized ? '还原' : '最大化');
      }
    });
    document.getElementById('harnessdock-shell-close')?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void run('harness_close', event.currentTarget);
    });
    void (async () => {
      const button = document.getElementById('harnessdock-shell-maximize');
      const state = await run('harness_window_state');
      if (button && state) {
        const maximized = Boolean(state.maximized);
        button.title = maximized ? '还原' : '最大化';
        button.setAttribute('aria-label', maximized ? '还原' : '最大化');
      }
    })();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
"##;
