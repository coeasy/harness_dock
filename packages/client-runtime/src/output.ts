import type { ParsedUrl } from './types.ts'

// dsh 0.1.2-alpha.1 protects the local Web UI with a per-process query token:
//   dsh web: http://127.0.0.1:43123/?token=...
// Preserve the complete URL for the one-time browser-cookie exchange. Dropping
// the query makes a healthy alpha server look permanently unready.
const LOOPBACK = /(https?:\/\/127\.0\.0\.1:(\d+)(?:\/[^\s\x1b]*)?)/
const TOKEN = /([?&]token=)[^&\s\x1b]+/gi

export function parseWebUrl(chunk: string): ParsedUrl | null {
  const match = LOOPBACK.exec(chunk)
  if (!match) return null
  const port = Number.parseInt(match[2]!, 10)
  return {
    url: match[1]!,
    host: '127.0.0.1',
    port,
  }
}

/** Keep the one-time browser launch credential out of persistent diagnostics. */
export function redactWebLaunchToken(text: string): string {
  return text.replace(TOKEN, '$1<redacted>')
}
