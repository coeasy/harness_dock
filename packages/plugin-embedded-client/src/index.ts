import { writeFileSync } from 'node:fs'
import { findListenAddress } from './listen.ts'

export const name = 'embedded-client'
// cordis 注入声明：等待 webServer 服务就绪后再启动监听探测，
// 否则 ctx.get('webServer') 会抛出 "cannot get property without inject"
export const inject = ['webServer']

interface PluginCtx {
  webServer?: unknown
  httpServer?: unknown
  get?: (name: string) => unknown
  effect?: (factory: () => () => void) => void
  on?: (event: string, listener: () => void) => void
}

export function apply(ctx: PluginCtx): void {
  const readyFile = process.env.DSH_EMBEDDED_READY_FILE
  if (!readyFile) return

  let written = false
  const tick = () => {
    if (written) return
    const addr = findListenAddress(ctx)
    if (!addr) return
    const payload = {
      url: `http://127.0.0.1:${addr.port}`,
      host: '127.0.0.1',
      port: addr.port,
      pid: process.pid,
      dshVersion: process.env.DSH_EMBEDDED_VERSION ?? 'unknown',
    }
    writeFileSync(readyFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    written = true
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const timer = setInterval(tick, 100)
      tick()
      return () => clearInterval(timer)
    })
    return
  }

  const timer = setInterval(tick, 100)
  tick()
  ctx.on?.('dispose', () => clearInterval(timer))
}
