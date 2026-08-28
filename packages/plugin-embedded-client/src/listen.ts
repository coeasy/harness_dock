export interface ListenAddress {
  host: string
  port: number
}

export function findListenAddress(ctx: unknown): ListenAddress | null {
  const candidates = collectServers(ctx)
  for (const server of candidates) {
    const address = typeof server?.address === 'function' ? server.address() : null
    if (address && typeof address === 'object') {
      const addr = address as { port?: unknown; address?: unknown }
      if (typeof addr.port === 'number' && addr.port > 0) {
        const host = typeof addr.address === 'string' && addr.address.length > 0
          ? normalizeHost(addr.address)
          : '127.0.0.1'
        return { host, port: addr.port }
      }
    }
  }
  return null
}

function normalizeHost(address: string): string {
  if (address === '::' || address === '::1') return '127.0.0.1'
  return address
}

function collectServers(ctx: unknown): Array<{ address?: () => unknown } | undefined> {
  if (!ctx || typeof ctx !== 'object') return []
  const root = ctx as Record<string, unknown>
  // 只通过 ctx.get('webServer') 获取：strict 模式下服务未就绪时返回 undefined 而非抛错；
  // 不能访问 root.httpServer 等任意属性，cordis 的 ctx Proxy 会对未注入属性抛错
  const candidates: Array<{ address?: () => unknown } | undefined> = [
    asServer(asRecord(readWebServer(root))?.server),
  ]
  return candidates
}

function readWebServer(root: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof root.get === 'function') {
    try {
      return asRecord(root.get('webServer'))
    } catch {
      return undefined
    }
  }
  return asRecord(root.webServer)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function asServer(value: unknown): { address?: () => unknown } | undefined {
  return value && typeof value === 'object' ? (value as { address?: () => unknown }) : undefined
}
