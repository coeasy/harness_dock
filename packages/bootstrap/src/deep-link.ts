import type { ClientCommandName } from './client-command-bus.ts'

export type HarnessDockDeepLinkIntent =
  | { type: 'chat-new' }
  | { type: 'session-open'; sessionId: string }
  | { type: 'workspace-open'; workspaceId: string }
  | { type: 'plugin-install'; pluginId: string }
  | { type: 'mcp-install'; serverId: string }
  | { type: 'device-pair'; token: string }
  | { type: 'auth-callback'; provider?: string; code?: string; error?: string; state: string }

const MAX_URL_LENGTH = 8 * 1024
const MAX_ID_LENGTH = 256
const MAX_TOKEN_LENGTH = 1024

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

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new InvalidHarnessDockDeepLinkError('Malformed percent-encoding in HarnessDock deep link')
  }
}

function validateId(value: string, name: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f\s?#]/.test(trimmed)) {
    throw new InvalidHarnessDockDeepLinkError(`Invalid ${name} in HarnessDock deep link`)
  }
  return trimmed
}

function validateToken(value: string): string {
  const token = value.trim()
  if (!token || token.length > MAX_TOKEN_LENGTH || /[\u0000-\u001f\u007f\s]/.test(token)) {
    throw new InvalidHarnessDockDeepLinkError('Invalid pair token in HarnessDock deep link')
  }
  return token
}

function boundedParam(value: string | null, name: string, max = 2048): string | undefined {
  if (value === null) return undefined
  if (!value || value.length > max || /[\u0000\u000d\u000a]/.test(value)) {
    throw new InvalidHarnessDockDeepLinkError(`Invalid ${name} in HarnessDock deep link`)
  }
  return value
}

export function parseHarnessDockDeepLink(input: string): HarnessDockDeepLinkIntent {
  if (!input || input.length > MAX_URL_LENGTH) {
    throw new InvalidHarnessDockDeepLinkError('HarnessDock deep link is empty or too long')
  }

  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw new InvalidHarnessDockDeepLinkError('Malformed HarnessDock deep link')
  }

  if (parsed.protocol !== 'harnessdock:') {
    throw new InvalidHarnessDockDeepLinkError(`Unsupported protocol: ${parsed.protocol}`)
  }
  if (parsed.username || parsed.password) {
    throw new InvalidHarnessDockDeepLinkError('Credentials are not allowed in HarnessDock deep links')
  }

  const segments = [parsed.hostname, ...parsed.pathname.split('/')]
    .map((segment) => safeDecode(segment))
    .filter(Boolean)

  if (segments[0] === 'chat' && segments[1] === 'new' && segments.length === 2) {
    return { type: 'chat-new' }
  }
  if (segments[0] === 'session' && segments[1] && segments.length === 2) {
    return { type: 'session-open', sessionId: validateId(segments[1], 'session id') }
  }
  if (segments[0] === 'workspace' && segments[1] === 'open') {
    throw new InvalidHarnessDockDeepLinkError(
      'Workspace filesystem paths are not allowed in deep links; use a workspace id or native picker',
    )
  }
  if (segments[0] === 'workspace' && segments[1] && segments.length === 2) {
    return { type: 'workspace-open', workspaceId: validateId(segments[1], 'workspace id') }
  }
  if (segments[0] === 'plugin' && segments[1] === 'install' && segments.length === 2) {
    return { type: 'plugin-install', pluginId: validateId(required(parsed.searchParams.get('id'), 'plugin id'), 'plugin id') }
  }
  if (segments[0] === 'mcp' && segments[1] === 'install' && segments.length === 2) {
    return { type: 'mcp-install', serverId: validateId(required(parsed.searchParams.get('id'), 'MCP server id'), 'MCP server id') }
  }
  if (segments[0] === 'pair' && segments.length === 1) {
    return { type: 'device-pair', token: validateToken(required(parsed.searchParams.get('token'), 'pair token')) }
  }
  if (segments[0] === 'auth' && segments[1] === 'callback' && segments.length === 2) {
    const state = boundedParam(required(parsed.searchParams.get('state'), 'OAuth state'), 'OAuth state', 1024)!
    const code = boundedParam(parsed.searchParams.get('code'), 'OAuth code', 4096)
    const error = boundedParam(parsed.searchParams.get('error'), 'OAuth error', 1024)
    if (Boolean(code) === Boolean(error)) {
      throw new InvalidHarnessDockDeepLinkError('OAuth callback must contain exactly one of code or error')
    }
    return {
      type: 'auth-callback',
      provider: boundedParam(parsed.searchParams.get('provider'), 'OAuth provider', 128),
      code,
      error,
      state,
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
      return { name: 'auth.callback', payload: intent }
  }
}
