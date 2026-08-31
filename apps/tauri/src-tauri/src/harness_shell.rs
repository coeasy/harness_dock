/// Minimal shell bridge injected into the loopback Harness WebView.
///
/// The official Harness UI stays the primary application surface. This script
/// adds one safe, on-demand entry point for the local Shell Settings plugin;
/// it never starts Runtime, changes DSH configuration, or exposes host controls.
pub(crate) const INIT_SCRIPT: &str = r##"
(() => {
  'use strict';

  const isLoopback = () => {
    const host = String(window.location.hostname || '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  };

  if (!isLoopback()) return;

  const invoke = () => window.__TAURI__?.core?.invoke;
  const openSettings = () => {
    const call = invoke();
    if (typeof call !== 'function') return;
    const button = document.getElementById('harnessdock-shell-settings-button');
    if (button) button.setAttribute('aria-busy', 'true');
    Promise.resolve(call('shell_settings_show'))
      .catch(() => undefined)
      .finally(() => {
        if (button) button.removeAttribute('aria-busy');
      });
  };

  const install = () => {
    if (!document.documentElement || document.getElementById('harnessdock-shell')) return;

    const style = document.createElement('style');
    style.id = 'harnessdock-shell-style';
    style.textContent = [
      '#harnessdock-shell{position:fixed;top:0;left:0;right:0;height:38px;z-index:2147483647;display:flex;align-items:center;justify-content:space-between;padding:0 10px 0 16px;background:linear-gradient(180deg,rgba(18,31,51,.98),rgba(9,18,32,.98));border-bottom:1px solid rgba(148,178,214,.18);box-shadow:0 1px 0 rgba(0,0,0,.28);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;user-select:none;-webkit-user-select:none}',
      '#harnessdock-shell .harnessdock-shell-brand{display:flex;align-items:center;gap:8px;color:#e9eef7;font-size:12px;font-weight:700;letter-spacing:.03em}',
      '#harnessdock-shell .harnessdock-shell-mark{width:16px;height:16px;border-radius:5px;background:radial-gradient(circle at 35% 30%,#6ee7d8 0%,#14b8a6 58%,#0d9488 100%);box-shadow:0 0 8px rgba(20,184,166,.42),inset 0 0 0 1px rgba(255,255,255,.18)}',
      '#harnessdock-shell .harnessdock-shell-mark:after{content:"";display:block;width:7px;height:7px;margin:4.5px;border-radius:50%;background:#d9fff6;box-shadow:0 0 5px rgba(126,231,214,.6)}',
      '#harnessdock-shell button{all:unset;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:8px;color:#c7d5e8;font-size:12px;font-weight:650;cursor:pointer;background:rgba(148,178,214,.1);border:1px solid rgba(148,178,214,.18);box-sizing:border-box}',
      '#harnessdock-shell button:hover{background:rgba(45,212,191,.16);color:#eafffb;border-color:rgba(45,212,191,.42)}',
      '#harnessdock-shell button:active{transform:scale(.97)}',
      '#harnessdock-shell button[aria-busy="true"]{opacity:.55;cursor:wait}',
      '#harnessdock-shell svg{width:13px;height:13px;flex:0 0 13px}',
      'html body{padding-top:38px!important}'
    ].join('');
    document.documentElement.appendChild(style);

    const bar = document.createElement('div');
    bar.id = 'harnessdock-shell';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'HarnessDock 外壳');
    bar.innerHTML = '<div class="harnessdock-shell-brand"><span class="harnessdock-shell-mark" aria-hidden="true"></span><span>HarnessDock</span></div><button id="harnessdock-shell-settings-button" type="button" title="打开外壳设置" aria-label="打开外壳设置"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Zm8.1 3.8c0-.5-.1-1-.2-1.4l-2-1.5 2-3.4-2.3-.9c-.7-.6-1.5-1-2.4-1.3L14.8 3h-4l-.4 2.3c-.9.3-1.7.7-2.4 1.3l-2.3-.9-2 3.4 2 1.5c-.1.5-.2 1-.2 1.4s.1 1 .2 1.4l-2 1.5 2 3.4 2.3-.9c.7.6 1.5 1 2.4 1.3l.4 2.3c.9.3 1.7.7 2.4 1.3l2.3-.9 2 3.4-2 1.5c.1.4.2.9.2 1.4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg><span>外壳设置</span></button>';
    document.documentElement.appendChild(bar);

    document.getElementById('harnessdock-shell-settings-button')?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openSettings();
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
"##;
