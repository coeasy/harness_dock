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
  let checking = false
  let disposed = false
  const tick = () => {
    if (written || checking || disposed) return
    const addr = findListenAddress(ctx)
    if (!addr) return

    // webServer.port is assigned as soon as the socket binds, but the
    // frontend-static fallback may still be registering its index route.
    // Probe the loopback page before announcing readiness so Electron never
    // races the dsh composition and loads a transient 404 as a blank screen.
    checking = true
    void probeWebUi(addr.port).then((ready) => {
      checking = false
      if (!ready || written || disposed) return
      try {
        const payload = {
          url: `http://127.0.0.1:${addr.port}`,
          host: '127.0.0.1',
          port: addr.port,
          pid: process.pid,
          dshVersion: process.env.DSH_EMBEDDED_VERSION ?? 'unknown',
        }
        writeFileSync(readyFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
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

async function probeWebUi(port: number): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1_000)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: controller.signal,
      redirect: 'manual',
    })
    if (!response.ok) return false
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType !== '' && !contentType.toLowerCase().includes('text/html')) return false
    const html = await response.text()
    return /<!doctype\s+html|<html(?:\s|>)/i.test(html)
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}
