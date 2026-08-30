import type { ClientCommandName } from './client-command-bus.ts'

export type HarnessDockDeepLinkIntent =
  | { type: 'chat-new' }
  | { type: 'session-open'; sessionId: string }
  | { type: 'workspace-open'; workspaceId: string }
  | { type: 'plugin-install'; pluginId: string }
  | { type: 'mcp-install'; serverId: string }
  | { type: 'device-pair'; token: string }
  | { type: 'auth-callback'; provider?: string; code?: string; state?: string }

export class InvalidHarnessDockDeepLinkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidHarnessDockDeepLinkError'
  }
}

function required(value: string | null, name: string): string {
  if (!value) throw new InvalidHarnessDockDeepLinkError(`Missing ${name} in HarnessDock deep link`)
  return value
}

export function parseHarnessDockDeepLink(input: string): HarnessDockDeepLinkIntent {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw new InvalidHarnessDockDeepLinkError('Malformed HarnessDock deep link')
  }

  if (parsed.protocol !== 'harnessdock:') {
    throw new InvalidHarnessDockDeepLinkError(`Unsupported protocol: ${parsed.protocol}`)
  }

  const segments = [parsed.hostname, ...parsed.pathname.split('/')]
    .map((segment) => decodeURIComponent(segment))
    .filter(Boolean)

  if (segments[0] === 'chat' && segments[1] === 'new' && segments.length === 2) {
    return { type: 'chat-new' }
  }
  if (segments[0] === 'session' && segments[1]) {
    return { type: 'session-open', sessionId: segments[1] }
  }
  if (segments[0] === 'workspace' && segments[1]) {
    return { type: 'workspace-open', workspaceId: segments[1] }
  }
  if (segments[0] === 'plugin' && segments[1] === 'install') {
    return { type: 'plugin-install', pluginId: required(parsed.searchParams.get('id'), 'plugin id') }
  }
  if (segments[0] === 'mcp' && segments[1] === 'install') {
    return { type: 'mcp-install', serverId: required(parsed.searchParams.get('id'), 'MCP server id') }
  }
  if (segments[0] === 'pair') {
    return { type: 'device-pair', token: required(parsed.searchParams.get('token'), 'pair token') }
  }
  if (segments[0] === 'auth' && segments[1] === 'callback') {
    return {
      type: 'auth-callback',
      provider: parsed.searchParams.get('provider') ?? undefined,
      code: parsed.searchParams.get('code') ?? undefined,
      state: parsed.searchParams.get('state') ?? undefined,
    }
  }

  throw new InvalidHarnessDockDeepLinkError('Unsupported HarnessDock deep link route')
}

export function deepLinkIntentToCommand(intent: HarnessDockDeepLinkIntent): {
  name: ClientCommandName
  payload: unknown
} {
  switch (intent.type) {
    case 'chat-new':
      return { name: 'app.focus', payload: { route: '/chat/new' } }
    case 'session-open':
      return { name: 'session.open', payload: { sessionId: intent.sessionId } }
    case 'workspace-open':
      return { name: 'workspace.open', payload: { workspaceId: intent.workspaceId } }
    case 'plugin-install':
      return { name: 'plugin.install', payload: { pluginId: intent.pluginId } }
    case 'mcp-install':
      return { name: 'mcp.install', payload: { serverId: intent.serverId } }
    case 'device-pair':
      return { name: 'device.pair', payload: { token: intent.token } }
    case 'auth-callback':
      return { name: 'app.focus', payload: { auth: intent } }
  }
}
