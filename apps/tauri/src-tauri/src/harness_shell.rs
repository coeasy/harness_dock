/// Minimal shell bridge injected into the loopback Harness WebView.
///
/// The official Harness UI stays the primary application surface. This script
/// adds safe, local-only controls for the separate Plugin Diagnostics window,
/// Web refresh/restart, signed updates and the Harness window lifecycle; it never changes DSH configuration,
/// or exposes remote host controls. The settings window is created only after
/// an explicit click and is never part of startup.
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
  let activeAction = false;
  let statusResetTimer;
  const notify = (value, bad = true) => {
    const toast = document.getElementById('harnessdock-shell-toast');
    if (!toast) return;
    toast.textContent = String(value?.message || value || '操作失败');
    toast.dataset.bad = bad ? 'true' : 'false';
    toast.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 4200);
  };
  const setShellAction = (action) => {
    activeAction = true;
    const statusContainer = document.getElementById('harnessdock-shell-status');
    const status = document.getElementById('harnessdock-shell-status-label');
    const progress = document.getElementById('harnessdock-shell-progress');
    const progressLabel = document.getElementById('harnessdock-shell-progress-label');
    if (status) status.textContent = action.label;
    statusContainer?.classList.add('is-busy');
    if (progressLabel) progressLabel.textContent = action.detail;
    if (progress) {
      progress.setAttribute('aria-hidden', 'false');
      progress.classList.add('is-visible');
    }
    document.querySelectorAll('#harnessdock-shell .harnessdock-shell-command').forEach((element) => {
      element.disabled = true;
    });
    window.clearTimeout(statusResetTimer);
  };

  const finishShellAction = (action, success) => {
    activeAction = false;
    const statusContainer = document.getElementById('harnessdock-shell-status');
    const status = document.getElementById('harnessdock-shell-status-label');
    const progress = document.getElementById('harnessdock-shell-progress');
    if (status) status.textContent = success ? action.done : '操作失败';
    statusContainer?.classList.remove('is-busy');
    if (success) notify(action.done, false);
    if (progress) {
      progress.classList.toggle('is-error', !success);
      window.setTimeout(() => {
        progress.classList.remove('is-visible', 'is-error');
        progress.setAttribute('aria-hidden', 'true');
      }, success ? 650 : 4200);
    }
    statusResetTimer = window.setTimeout(() => {
      if (!activeAction && status) status.textContent = '就绪';
    }, success ? 1100 : 4400);
  };

  const run = async (command, button, action) => {
    if (action && activeAction) return undefined;
    const call = invoke();
    if (typeof call !== 'function') {
      notify('外壳 IPC 尚未就绪，请稍后重试。');
      return undefined;
    }
    if (action) setShellAction(action);
    if (button) {
      button.setAttribute('aria-busy', 'true');
      button.disabled = true;
    }
    try {
      const result = await call(command);
      if (action) {
        const done = typeof action.done === 'function' ? action.done(result) : action.done;
        finishShellAction({ ...action, done }, true);
      }
      return result;
    } catch (error) {
      if (action) finishShellAction(action, false);
      notify(error);
      return undefined;
    } finally {
      if (button) {
        button.removeAttribute('aria-busy');
        button.disabled = false;
      }
      if (action && !activeAction) {
        document.querySelectorAll('#harnessdock-shell .harnessdock-shell-command').forEach((element) => {
          element.disabled = false;
        });
      }
    }
  };

  const install = () => {
    if (!document.documentElement || document.getElementById('harnessdock-shell')) return;

    const listen = window.__TAURI__?.event?.listen;
    if (typeof listen === 'function') {
      void listen('harnessdock-shell-error', (event) => notify(event?.payload));
    }

    const style = document.createElement('style');
    style.id = 'harnessdock-shell-style';
    style.textContent = [
      ':root{--harnessdock-shell-top-inset:42px;--harnessdock-shell-bottom-inset:12px}',
      '#harnessdock-shell{position:fixed;top:0;left:0;right:0;height:42px;z-index:2147483647;display:flex;align-items:center;justify-content:space-between;padding:0 10px 0 16px;background:linear-gradient(180deg,rgba(18,31,51,.98),rgba(9,18,32,.98));border-bottom:1px solid rgba(148,178,214,.18);box-shadow:0 1px 0 rgba(0,0,0,.28);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;user-select:none;-webkit-user-select:none}',
      '#harnessdock-shell .harnessdock-shell-drag{display:flex;align-items:center;min-width:0;flex:1;height:100%;-webkit-app-region:drag}',
      '#harnessdock-shell .harnessdock-shell-brand{display:flex;align-items:center;gap:8px;color:#e9eef7;font-size:12px;font-weight:700;letter-spacing:.03em}',
      '#harnessdock-shell .harnessdock-shell-mark{width:16px;height:16px;border-radius:5px;background:radial-gradient(circle at 35% 30%,#6ee7d8 0%,#14b8a6 58%,#0d9488 100%);box-shadow:0 0 8px rgba(20,184,166,.42),inset 0 0 0 1px rgba(255,255,255,.18)}',
      '#harnessdock-shell .harnessdock-shell-mark:after{content:"";display:block;width:7px;height:7px;margin:4.5px;border-radius:50%;background:#d9fff6;box-shadow:0 0 5px rgba(126,231,214,.6)}',
      '#harnessdock-shell .harnessdock-shell-status{display:inline-flex;align-items:center;gap:6px;margin-left:14px;color:#8fa5c2;font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#harnessdock-shell .harnessdock-shell-status-dot{width:7px;height:7px;flex:0 0 7px;border-radius:50%;background:#2dd4bf;box-shadow:0 0 8px rgba(45,212,191,.7)}',
      '#harnessdock-shell .harnessdock-shell-status.is-busy .harnessdock-shell-status-dot{border:2px solid rgba(110,231,216,.22);border-top-color:#2dd4bf;background:transparent;animation: harnessdock-spin .8s linear infinite}',
      '#harnessdock-shell .harnessdock-shell-actions{position:relative;display:flex;align-items:center;gap:4px;height:100%;max-width:calc(100vw - 72px);overflow:visible;-webkit-app-region:no-drag}',
      '@keyframes harnessdock-spin{to{transform:rotate(360deg)}}',
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
      '#harnessdock-shell .harnessdock-shell-menu{position:relative;height:100%;display:flex;align-items:center}',
      '#harnessdock-shell .harnessdock-shell-menu-toggle{min-width:58px}',
      '#harnessdock-shell .harnessdock-shell-menu-toggle[aria-expanded="true"]{background:rgba(45,212,191,.2);color:#eafffb;border-color:rgba(45,212,191,.45)}',
      '#harnessdock-shell .harnessdock-shell-menu-panel{position:absolute;top:calc(100% + 6px);right:0;z-index:2;display:none;width:252px;padding:6px;border:1px solid rgba(148,178,214,.22);border-radius:12px;background:rgba(10,21,37,.98);box-shadow:0 16px 35px rgba(0,0,0,.42);-webkit-app-region:no-drag}',
      '#harnessdock-shell .harnessdock-shell-menu-panel.is-open{display:flex;flex-direction:column;gap:4px;animation:harnessdock-menu-in .14s ease-out}',
      '@keyframes harnessdock-menu-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}',
      '#harnessdock-shell .harnessdock-shell-menu-item{width:100%;height:34px;justify-content:flex-start;padding:0 10px;background:transparent;border-color:transparent;text-align:left}',
      '#harnessdock-shell .harnessdock-shell-menu-item small{margin-left:auto;color:#6f86a4;font-size:10px;font-weight:500}',
      '#harnessdock-shell .harnessdock-shell-menu-item.danger{color:#ffb4b4}',
      '#harnessdock-shell-progress{position:fixed;top:calc(var(--harnessdock-shell-top-inset) + 8px);left:50%;z-index:2147483646;display:flex;align-items:center;gap:9px;max-width:min(430px,calc(100vw - 24px));padding:9px 13px;border:1px solid rgba(45,212,191,.28);border-radius:11px;background:rgba(7,28,39,.96);box-shadow:0 12px 28px rgba(0,0,0,.3);color:#c7fff6;font:600 12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;opacity:0;pointer-events:none;transform:translate(-50%,-6px);transition:opacity .16s ease,transform .16s ease}',
      '#harnessdock-shell-progress.is-visible{opacity:1;transform:translate(-50%,0)}',
      '#harnessdock-shell-progress.is-error{border-color:rgba(248,113,113,.45);background:rgba(49,19,28,.96);color:#fecaca}',
      '#harnessdock-shell-progress-spinner{width:14px;height:14px;flex:0 0 14px;border:2px solid rgba(110,231,216,.2);border-top-color:#2dd4bf;border-radius:50%;animation:harnessdock-spin .8s linear infinite}',
      '#harnessdock-shell-toast{position:fixed;top:52px;right:12px;max-width:min(360px,calc(100vw - 24px));padding:9px 12px;border:1px solid rgba(248,113,113,.45);border-radius:10px;background:rgba(49,19,28,.96);color:#fecaca;font-size:12px;line-height:1.45;opacity:0;transform:translateY(-4px);pointer-events:none;transition:opacity .18s ease,transform .18s ease}',
      '#harnessdock-shell-toast[data-bad="false"]{border-color:rgba(45,212,191,.42);background:rgba(7,47,38,.96);color:#b8fff2}',
      '#harnessdock-shell-toast.is-visible{opacity:1;transform:translateY(0)}',
      'html.harnessdock-shell-mounted{height:100%!important;overflow:hidden!important;scroll-padding-top:var(--harnessdock-shell-top-inset);scroll-padding-bottom:var(--harnessdock-shell-bottom-inset)}',
      'html.harnessdock-shell-mounted body{box-sizing:border-box!important;height:100vh!important;min-height:0!important;margin:0!important;padding-top:var(--harnessdock-shell-top-inset)!important;padding-bottom:var(--harnessdock-shell-bottom-inset)!important;overflow:hidden!important}',
      'html.harnessdock-shell-mounted body #root,html.harnessdock-shell-mounted body #app,html.harnessdock-shell-mounted body [data-reactroot]{box-sizing:border-box!important;height:100%!important;min-height:0!important;max-height:100%!important;overflow:auto!important}',
      '@media (max-width:720px){#harnessdock-shell{padding-left:10px;padding-right:7px}#harnessdock-shell .harnessdock-shell-brand span:last-child,#harnessdock-shell .harnessdock-shell-status-label{display:none}#harnessdock-shell .harnessdock-shell-status{margin-left:8px}#harnessdock-shell .harnessdock-shell-actions{max-width:calc(100vw - 34px);gap:3px}#harnessdock-shell button{padding-left:7px;padding-right:7px;font-size:11px}#harnessdock-shell .harnessdock-shell-menu-panel{right:-6px}}',
      '@media (prefers-reduced-motion: reduce){#harnessdock-shell-progress,#harnessdock-shell-progress.is-visible,#harnessdock-shell-toast,#harnessdock-shell-toast.is-visible{transition:none}#harnessdock-shell-progress-spinner,#harnessdock-shell .harnessdock-shell-status.is-busy .harnessdock-shell-status-dot{animation:none}}'
    ].join('');
    document.documentElement.appendChild(style);

    const bar = document.createElement('div');
    bar.id = 'harnessdock-shell';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'HarnessDock 外壳');
    bar.innerHTML = '<div class="harnessdock-shell-drag"><div class="harnessdock-shell-brand"><span class="harnessdock-shell-mark" aria-hidden="true"></span><span>HarnessDock</span></div></div><div class="harnessdock-shell-actions"><button id="harnessdock-shell-settings-button" class="harnessdock-shell-settings" type="button" title="打开插件诊断" aria-label="打开插件诊断"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Zm8.1 3.8c0-.5-.1-1-.2-1.4l-2-1.5 2-3.4-2.3-.9c-.7-.6-1.5-1-2.4-1.3L14.8 3h-4l-.4 2.3c-.9.3-1.7.7-2.4 1.3l-2.3-.9-2 3.4 2 1.5c-.1.5-.2 1-.2 1.4s.1 1 .2 1.4l-2 1.5 2 3.4 2.3-.9c.7.6 1.5 1 2.4 1.3l.4 2.3c.9.3 1.7.7 2.4 1.3l2.3-.9 2 3.4-2 1.5c.1.4.2.9.2 1.4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg><span>插件诊断</span></button><span class="harnessdock-shell-separator" aria-hidden="true"></span><button id="harnessdock-shell-minimize" class="harnessdock-shell-window-control" type="button" title="最小化" aria-label="最小化"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button><button id="harnessdock-shell-maximize" class="harnessdock-shell-window-control" type="button" title="最大化" aria-label="最大化"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button><button id="harnessdock-shell-close" class="harnessdock-shell-window-control harnessdock-shell-close" type="button" title="隐藏到托盘" aria-label="隐藏到托盘"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></div><div id="harnessdock-shell-toast" role="status" aria-live="polite"></div>';
    document.documentElement.appendChild(bar);
    const statusContainer = document.createElement('div');
    statusContainer.id = 'harnessdock-shell-status';
    statusContainer.className = 'harnessdock-shell-status';
    statusContainer.setAttribute('role', 'status');
    statusContainer.setAttribute('aria-live', 'polite');
    statusContainer.innerHTML = '<span class="harnessdock-shell-status-dot" aria-hidden="true"></span><span id="harnessdock-shell-status-label">就绪</span>';
    bar.querySelector('.harnessdock-shell-drag')?.appendChild(statusContainer);
    const progress = document.createElement('div');
    progress.id = 'harnessdock-shell-progress';
    progress.setAttribute('aria-hidden', 'true');
    progress.innerHTML = '<span id="harnessdock-shell-progress-spinner" aria-hidden="true"></span><span id="harnessdock-shell-progress-label"></span>';
    document.documentElement.appendChild(progress);
    const syncLayoutInsets = () => {
      const height = Math.ceil(bar.getBoundingClientRect().height || 42);
      document.documentElement.style.setProperty('--harnessdock-shell-top-inset', `${height}px`);
      document.documentElement.style.setProperty('--harnessdock-shell-bottom-inset', '12px');
      document.documentElement.classList.add('harnessdock-shell-mounted');
    };
    syncLayoutInsets();
    window.addEventListener('resize', syncLayoutInsets, { passive: true });

    const actions = bar.querySelector('.harnessdock-shell-actions');
    const settingsButton = document.getElementById('harnessdock-shell-settings-button');
    settingsButton?.classList.add('harnessdock-shell-command');
    if (settingsButton) {
      settingsButton.title = '打开插件诊断';
      settingsButton.setAttribute('aria-label', '打开插件诊断');
      const label = settingsButton.querySelector('span');
      if (label) label.textContent = '插件诊断';
    }
    const createWebAction = (id, label, title) => {
      const button = document.createElement('button');
      button.id = id;
      button.className = 'harnessdock-shell-menu-item harnessdock-shell-command';
      button.type = 'button';
      button.title = title;
      button.setAttribute('aria-label', title);
      button.textContent = label;
      return button;
    };
    const refreshButton = createWebAction(
      'harnessdock-shell-refresh-web',
      '刷新 Web',
      '刷新 Web（不重启 Runtime）',
    );
    const restartButton = createWebAction(
      'harnessdock-shell-restart-web',
      '重启 Runtime 并刷新 Web',
      '重启 Runtime 并刷新 Web',
    );
    const quarantineRestartButton = createWebAction(
      'harnessdock-shell-quarantine-restart',
      '清除插件隔离并重启',
      '清除插件隔离记录，然后重启 Runtime 并刷新 Web',
    );
    quarantineRestartButton.classList.add('danger');
    const updateButton = createWebAction(
      'harnessdock-shell-update',
      '自动更新',
      '检查并安装已签名的最新 HarnessDock 版本',
    );

    const menu = document.createElement('div');
    menu.className = 'harnessdock-shell-menu';
    const menuToggle = document.createElement('button');
    menuToggle.id = 'harnessdock-shell-menu-toggle';
    menuToggle.className = 'harnessdock-shell-menu-toggle';
    menuToggle.type = 'button';
    menuToggle.title = '打开 Harness 菜单';
    menuToggle.setAttribute('aria-label', '打开 Harness 菜单');
    menuToggle.setAttribute('aria-haspopup', 'menu');
    menuToggle.setAttribute('aria-controls', 'harnessdock-shell-menu-panel');
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.innerHTML = '菜单<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const menuPanel = document.createElement('div');
    menuPanel.id = 'harnessdock-shell-menu-panel';
    menuPanel.className = 'harnessdock-shell-menu-panel';
    menuPanel.setAttribute('role', 'menu');
    menuPanel.setAttribute('aria-label', 'Harness 菜单');
    [refreshButton, restartButton, quarantineRestartButton, settingsButton, updateButton].forEach((button) => {
      button.setAttribute('role', 'menuitem');
    });
    settingsButton.classList.add('harnessdock-shell-menu-item');
    bar.querySelector('.harnessdock-shell-separator')?.remove();
    menuPanel.append(refreshButton, restartButton, quarantineRestartButton, settingsButton, updateButton);
    menu.append(menuToggle, menuPanel);
    actions?.prepend(menu);
    ['harnessdock-shell-minimize', 'harnessdock-shell-maximize', 'harnessdock-shell-close'].forEach((id) => {
      document.getElementById(id)?.classList.add('harnessdock-shell-command');
    });

    const closeMenu = () => {
      menuPanel.classList.remove('is-open');
      menuToggle.setAttribute('aria-expanded', 'false');
    };
    menuToggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (activeAction) return;
      const open = !menuPanel.classList.contains('is-open');
      menuPanel.classList.toggle('is-open', open);
      menuToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', (event) => {
      if (!menu.contains(event.target)) closeMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMenu();
    });

    refreshButton.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      await run('harness_reload_web', refreshButton, {
        label: '刷新中',
        detail: '正在重新加载 Harness Web，Runtime 保持运行…',
        done: '刷新完成',
      });
    });
    restartButton.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      await run('harness_restart_web', restartButton, {
        label: '重启中',
        detail: '正在停止并重新启动 Runtime，完成后刷新 Web…',
        done: '重启完成',
      });
    });
    quarantineRestartButton.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      await run('harness_clear_quarantine_restart', quarantineRestartButton, {
        label: '恢复中',
        detail: '正在清除插件隔离记录并重启 Runtime…',
        done: '插件恢复完成',
      });
    });
    updateButton.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      await run('update_install', updateButton, {
        label: '更新中',
        detail: '正在检查并下载签名更新，完成后将安全重启 HarnessDock…',
        done: (result) => result?.status === 'latest'
          ? '当前已是最新版本'
          : '更新已安装，正在重启 HarnessDock…',
      });
    });

    document.getElementById('harnessdock-shell-settings-button')?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      void run('shell_settings_show', event.currentTarget, {
        label: '打开中',
        detail: '正在打开插件诊断窗口…',
        done: '插件诊断已打开',
      });
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
