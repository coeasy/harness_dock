import type { ParsedUrl } from './types.ts'

// dsh 0.1.2-alpha.1 protects the local Web UI with a per-process query token:
//   dsh web: http://127.0.0.1:43123/?token=...
// Preserve the complete URL. Dropping the query makes a healthy alpha server
// look permanently unready because every unauthenticated probe is rejected.
const LOOPBACK = /(https?:\/\/127\.0\.0\.1:(\d+)(?:\/[^\s\x1b]*)?)/

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
