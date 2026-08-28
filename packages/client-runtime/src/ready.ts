import { writeFile } from 'node:fs/promises'
import type { ReadyInfo } from './types.ts'

export async function writeReadyFile(filePath: string, info: ReadyInfo): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(info, null, 2)}\n`, 'utf8')
}

export function parseReadyFile(raw: string): ReadyInfo | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ReadyInfo>
    if (
      typeof parsed.url !== 'string' ||
      typeof parsed.host !== 'string' ||
      typeof parsed.port !== 'number' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.dshVersion !== 'string'
    ) {
      return null
    }
    return parsed as ReadyInfo
  } catch {
    return null
  }
}
