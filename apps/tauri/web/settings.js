(() => {
  'use strict'

  const $ = (id) => document.getElementById(id)
  let requestSequence = 0
  let lastSequence = 0
  let unlistenHostEvent = null

  function call(command, args) {
    const invoke = window.__TAURI__?.core?.invoke
    if (typeof invoke !== 'function') return Promise.reject(new Error('Tauri IPC is unavailable.'))
    return invoke(command, args)
  }

  function host(commandType) {
    const requestId = globalThis.crypto?.randomUUID?.() || `diagnostics-${Date.now()}-${++requestSequence}`
    return call('host_execute', {
      envelope: {
        protocolVersion: 2,
        requestId,
        subject: 'diagnostics',
        command: { type: commandType },
      },
    }).then((response) => {
      if (response?.result?.Err) throw new Error(String(response.result.Err.message || 'Host command denied'))
      return response?.result?.Ok ?? response
    })
  }

  function message(value) {
    return String(value?.message || value || '未知错误')
  }

  function setStatus(element, value, bad = false) {
    if (!element) return
    element.textContent = value || ''
    element.classList.toggle('error', bad)
  }

  function render(snapshot) {
    if (!snapshot) return
    const sequence = Number(snapshot.eventSequence || 0)
    if (!Number.isSafeInteger(sequence) || sequence < lastSequence) return
    lastSequence = sequence
    const phase = snapshot.runtimePhase || 'stopped'
    $('runtime-state').textContent = phase
    const lines = [
      `状态：${phase}`,
      `版本：${snapshot.runtimeDshVersion || 'unknown'}`,
      `Generation：${snapshot.runtimeGeneration ?? 'unknown'}`,
      `Runtime Image：${snapshot.runtimeImageIdentity || 'unknown'}`,
      `Host Protocol：v${snapshot.protocolVersion || 2}（最低兼容 v${snapshot.minCompatibleVersion || 2}）`,
      `Kernel Revision：${snapshot.revision ?? 0}`,
      `Event Sequence：${snapshot.eventSequence ?? 0}`,
    ]
    setStatus($('runtime-detail'), lines.join('\n'))
    setStatus(
      $('web-detail'),
      snapshot.harnessVisible
        ? 'Harness Web 主 Surface 已由 Host Kernel 管理；诊断、Gateway 或更新失败不会替代健康主链。'
        : 'Harness Web 当前不可见；可关闭诊断窗口后从原生菜单重新显示或恢复。',
    )
  }

  async function refresh() {
    try {
      render(await call('host_snapshot'))
    } catch (error) {
      setStatus($('runtime-detail'), message(error), true)
    }
  }

  async function quit() {
    $('settings-quit').disabled = true
    setStatus($('runtime-detail'), '正在通过 Host Kernel 关闭 Runtime、Gateway 与客户端…')
    try {
      await host('quit')
    } catch (error) {
      setStatus($('runtime-detail'), message(error), true)
      $('settings-quit').disabled = false
    }
  }

  async function installUpdate() {
    const button = $('update-install')
    button.disabled = true
    setStatus($('update-detail'), '正在检查稳定 Release；已配置发布签名时才会执行安全自动安装…')
    try {
      await host('install-update')
      setStatus($('update-detail'), '更新操作已交给 UpdateActor；状态变化将通过 HostEvent 推送。')
    } catch (error) {
      setStatus($('update-detail'), message(error), true)
    } finally {
      button.disabled = false
    }
  }

  async function subscribe() {
    const listen = window.__TAURI__?.event?.listen
    if (typeof listen !== 'function') return
    unlistenHostEvent = await listen('harnessdock://host-event', async (event) => {
      const payload = event?.payload || {}
      const sequence = Number(payload.sequence || 0)
      if (!Number.isSafeInteger(sequence) || sequence <= lastSequence) return
      if (lastSequence && sequence > lastSequence + 1) {
        // A lost event is repaired by a full source-of-truth snapshot.
        await refresh()
        return
      }
      lastSequence = sequence
      await refresh()
    })
  }

  $('runtime-refresh').addEventListener('click', refresh)
  $('settings-quit').addEventListener('click', quit)
  $('update-install').addEventListener('click', installUpdate)
  $('settings-close').addEventListener('click', async () => {
    try { await call('diagnostics_close') } catch (error) { setStatus($('runtime-detail'), message(error), true) }
  })

  void (async () => {
    try {
      await subscribe()
      await refresh()
    } catch (error) {
      setStatus($('runtime-detail'), message(error), true)
    }
  })()
  window.addEventListener('pagehide', () => {
    if (typeof unlistenHostEvent === 'function') unlistenHostEvent()
  }, { once: true })
})()
