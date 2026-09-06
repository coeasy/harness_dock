import { writeFileSync } from 'node:fs'
import { findListenAddress } from './listen.ts'
import {
  RUNTIME_READY_ENV,
  RUNTIME_READY_LOOPBACK_HOST,
} from './runtime-ready-contract.generated.ts'
import { browserUrlFor, probeBrowserUrl } from './web-auth.ts'

export const name = 'embedded-client'
// `webServer` alone is not a readiness boundary. The official dsh Web bundle
// waits for the Loader tree before announcing its browser URL because a sibling
// route/plugin can still fail after the server first binds. Require Connection
// too, then mirror that Loader-settlement contract before publishing ready.json.
export const inject = ['webServer', 'connection']

interface LoaderLike {
  await?: () => Promise<unknown>
}

interface PluginCtx {
  webServer?: unknown
  connection?: unknown
  httpServer?: unknown
  get?: (name: string) => unknown
  effect?: (factory: () => () => void) => void
  on?: (event: string, listener: () => void) => void
}

function getService(ctx: PluginCtx, name: string): unknown {
  try {
    return ctx.get?.(name)
  } catch {
    return undefined
  }
}

function loaderSettlement(ctx: PluginCtx): Promise<unknown> | undefined {
  const loader = getService(ctx, 'loader') as LoaderLike | undefined
  return typeof loader?.await === 'function' ? loader.await() : undefined
}

function runtimeServicesPresent(ctx: PluginCtx): boolean {
  if (typeof ctx.get !== 'function') {
    return ctx.webServer !== undefined && ctx.connection !== undefined
  }
  return getService(ctx, 'webServer') !== undefined && getService(ctx, 'connection') !== undefined
}

export function apply(ctx: PluginCtx): void {
  const readyFile = process.env[RUNTIME_READY_ENV.readyFile]
  if (!readyFile) return

  const generation = Number.parseInt(process.env[RUNTIME_READY_ENV.generation] ?? '', 10)
  const nonce = process.env[RUNTIME_READY_ENV.nonce] ?? ''
  const imageIdentity = process.env[RUNTIME_READY_ENV.imageIdentity] ?? ''
  if (!Number.isSafeInteger(generation) || generation <= 0 || !nonce || !imageIdentity) {
    // A managed Runtime must never publish an unbound ready file. Refusing to
    // write here makes every host fail closed instead of accepting readiness
    // from another process/generation.
    return
  }

  let written = false
  let checking = false
  let disposed = false
  let timer: ReturnType<typeof setInterval> | undefined
  let consecutiveHealthyProbes = 0

  const stop = () => {
    disposed = true
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  const tick = () => {
    if (written || checking || disposed) return
    if (!runtimeServicesPresent(ctx)) {
      consecutiveHealthyProbes = 0
      return
    }
    const addr = findListenAddress(ctx)
    if (!addr) {
      consecutiveHealthyProbes = 0
      return
    }

    // Resolve the official authenticated browser URL through Connection and
    // perform the same token -> cookie -> clean HTML handshake a real browser
    // performs. One successful response is not enough: the Web listener can be
    // transient while the Loader is still settling/tearing down. Require three
    // consecutive successful probes before publishing a RuntimeLease boundary.
    const baseUrl = `http://${RUNTIME_READY_LOOPBACK_HOST}:${addr.port}`
    const browserUrl = browserUrlFor(ctx, baseUrl)
    checking = true
    void probeBrowserUrl(browserUrl).then((ready) => {
      checking = false
      if (written || disposed) return
      if (!ready || !runtimeServicesPresent(ctx)) {
        consecutiveHealthyProbes = 0
        return
      }
      consecutiveHealthyProbes += 1
      if (consecutiveHealthyProbes < 3) return
      try {
        const payload = {
          url: browserUrl,
          host: RUNTIME_READY_LOOPBACK_HOST,
          port: addr.port,
          pid: process.pid,
          dshVersion: process.env[RUNTIME_READY_ENV.dshVersion] ?? 'unknown',
          generation,
          nonce,
          imageIdentity,
        }
        writeFileSync(readyFile, `${JSON.stringify(payload, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        })
        written = true
        if (timer !== undefined) {
          clearInterval(timer)
          timer = undefined
        }
      } catch {
        // The runtime may be shutting down and have removed its temp folder.
        consecutiveHealthyProbes = 0
      }
    }, () => {
      checking = false
      consecutiveHealthyProbes = 0
    })
  }

  const beginProbing = () => {
    if (disposed || written || timer !== undefined || !runtimeServicesPresent(ctx)) return
    timer = setInterval(tick, 100)
    tick()
  }

  const beginAfterLoaderSettlement = () => {
    const settled = loaderSettlement(ctx)
    if (settled === undefined) {
      // Hand-built trees without Loader are already complete, matching the
      // upstream web-app readiness contract.
      beginProbing()
      return
    }
    void settled.then(() => {
      if (!disposed && runtimeServicesPresent(ctx)) beginProbing()
    }, () => {
      // A rejected Loader means boot failed. Never publish a ready file for a
      // server that may already be tearing down while the Node process remains.
      stop()
    })
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      beginAfterLoaderSettlement()
      return stop
    })
    return
  }

  beginAfterLoaderSettlement()
  ctx.on?.('dispose', stop)
}
