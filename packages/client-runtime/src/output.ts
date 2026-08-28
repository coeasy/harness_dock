import type { ParsedUrl } from './types.ts'

const LOOPBACK = /https?:\/\/127\.0\.0\.1:(\d+)\b/

export function parseWebUrl(chunk: string): ParsedUrl | null {
  const match = LOOPBACK.exec(chunk)
  if (!match) return null
  const port = Number.parseInt(match[1]!, 10)
  return {
    url: `http://127.0.0.1:${port}`,
    host: '127.0.0.1',
    port,
  }
}
