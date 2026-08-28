export interface ListenAddress {
  host: string
  port: number
}

export function findListenAddress(ctx: unknown): ListenAddress | null {
  const webServer = readWebServer(ctx)
  if (!webServer) return null

  // dsh-host-webserver publishes the assigned port as a service property.
  // This is the authoritative signal when --port 0 lets Node choose a port;
  // the underlying http.Server is an implementation detail and may not be
  // reachable at the exact moment the plugin effect runs.
  const publishedPort = readPort(webServer.port)
  if (publishedPort !== null) {
    return {
      host: normalizeHost(typeof webServer.host === 'string' ? webServer.host : '127.0.0.1'),
      port: publishedPort,
    }
  }

  // Keep compatibility with older dsh web-server implementations that only
  // exposed the Node server object.
  for (const server of collectServers(webServer)) {
    const address = typeof server?.address === 'function' ? server.address() : null
    if (address && typeof address === 'object') {
      const addr = address as { port?: unknown; address?: unknown }
      const port = readPort(addr.port)
      if (port !== null) {
        const host = typeof addr.address === 'string' && addr.address.length > 0
          ? normalizeHost(addr.address)
          : '127.0.0.1'
        return { host, port }
      }
    }
  }
  return null
}

function readPort(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535
    ? value
    : null
}

function normalizeHost(address: string): string {
  if (
    address === '::' ||
    address === '::1' ||
    address === '0.0.0.0' ||
    address === '::ffff:0.0.0.0' ||
    address === '::ffff:127.0.0.1'
  ) return '127.0.0.1'
  return address
}

function collectServers(webServer: Record<string, unknown>): Array<{ address?: () => unknown } | undefined> {
  const candidates = [
    webServer,
    webServer.server,
    webServer.httpServer,
    webServer.listener,
  ]
  return candidates.map(asServer)
}

function readWebServer(ctx: unknown): Record<string, unknown> | undefined {
  if (!ctx || typeof ctx !== 'object') return undefined
  const root = ctx as Record<string, unknown>
  // 只通过 ctx.get('webServer') 获取：strict 模式下服务未就绪时返回 undefined 而非抛错；
  // 不能访问 root.httpServer 等任意属性，cordis 的 ctx Proxy 会对未注入属性抛错
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
