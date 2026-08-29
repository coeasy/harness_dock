import type { ParsedUrl } from './types.ts'

// Keep the complete loopback URL. dsh 0.1.2+ appends a browser launch token
// (`/?token=...`) which must survive until Electron navigates to the page.
const LOOPBACK = /(https?:\/\/127\.0\.0\.1:(\d+)(?:\/[^\s)\]}>'"\u001b]*)?)/i
const WEB_TOKEN = /([?&]token=)[^&\s)\]}>'"\u001b]+/gi

export function parseWebUrl(chunk: string): ParsedUrl | null {
  const match = LOOPBACK.exec(chunk)
  if (!match) return null
  const rawUrl = match[1]!
  const port = Number.parseInt(match[2]!, 10)
  try {
    const parsed = new URL(rawUrl)
    if (parsed.hostname !== '127.0.0.1' || Number.parseInt(parsed.port, 10) !== port) return null
  } catch {
    return null
  }
  return {
    url: rawUrl,
    host: '127.0.0.1',
    port,
  }
}

/** Prevent dsh 0.1.2+ browser launch credentials from leaking into diagnostics. */
export function redactWebAuthTokens(text: string): string {
  return text.replace(WEB_TOKEN, '$1<redacted>')
}
