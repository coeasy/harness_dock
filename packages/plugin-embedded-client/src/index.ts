import { writeFileSync } from 'node:fs'
import { findListenAddress } from './listen.ts'
import { browserUrlFor, probeBrowserUrl } from './web-auth.ts'

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
  let checking = false
  let disposed = false
  const tick = () => {
    if (written || checking || disposed) return
    const addr = findListenAddress(ctx)
    if (!addr) return

    // dsh 0.1.2+ index.html with its process launch token. Resolve the
    // official browser URL through Connection when available, then perform the
    // same token -> cookie -> clean-page handshake a real browser performs.
    // Older runtimes have no authenticatedUrl() and keep using the bare URL.
    const baseUrl = `http://127.0.0.1:${addr.port}`
    const browserUrl = browserUrlFor(ctx, baseUrl)
    checking = true
    void probeBrowserUrl(browserUrl).then((ready) => {
      checking = false
      if (!ready || written || disposed) return
      try {
        const payload = {
          url: browserUrl,
          host: '127.0.0.1',
          port: addr.port,
          pid: process.pid,
          dshVersion: process.env.DSH_EMBEDDED_VERSION ?? 'unknown',
        }
        writeFileSync(readyFile, `${JSON.stringify(payload, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        })
        written = true
      } catch {
        // The runtime may be shutting down and have removed its temp folder.
      }
    })
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const timer = setInterval(tick, 100)
      tick()
      return () => {
        disposed = true
        clearInterval(timer)
      }
    })
    return
  }

  const timer = setInterval(tick, 100)
  tick()
  ctx.on?.('dispose', () => {
    disposed = true
    clearInterval(timer)
  })
}
