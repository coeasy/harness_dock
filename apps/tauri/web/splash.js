(() => {
  'use strict'

  let transitionTimer

  function stateFor(value) {
    const text = String(value || '')
    if (/失败|错误|异常|error/i.test(text)) return 'error'
    if (/退出|关闭|shutdown|quit|stopping/i.test(text)) return 'exiting'
    if (/已就绪|完成|ready/i.test(text)) return 'ready'
    return 'loading'
  }

  function hintFor(state) {
    if (state === 'exiting') return '正在清理受管 Runtime 与 Gateway，请勿重复操作'
    if (state === 'error') return 'HarnessDock 会进入恢复入口，主程序不会静默退出'
    if (state === 'ready') return 'Harness Web 已准备完成'
    return '保持窗口打开，Harness Web 就绪后会自动进入'
  }

  window.__harnessDockSetStatus = (value) => {
    const element = document.getElementById('splash-status')
    if (!element) return

    const text = String(value || '正在执行…')
    const state = stateFor(text)
    const hint = document.querySelector('.hint')
    const main = document.querySelector('.splash')

    document.documentElement.dataset.state = state
    if (main) main.setAttribute('aria-busy', state === 'ready' || state === 'error' ? 'false' : 'true')
    if (hint) hint.textContent = hintFor(state)

    window.clearTimeout(transitionTimer)
    element.classList.add('changing')
    transitionTimer = window.setTimeout(() => {
      element.textContent = text
      element.classList.remove('changing')
    }, 90)
  }
})()
