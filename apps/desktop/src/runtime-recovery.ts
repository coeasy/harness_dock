import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

interface RuntimeRecoveryState {
  schemaVersion: 1
  crashes: string[]
}

export interface RuntimeRestartDecision {
  allowed: boolean
  attempt: number
  delayMs: number
}

async function writeAtomic(file: string, value: RuntimeRecoveryState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

async function readState(file: string): Promise<RuntimeRecoveryState> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as RuntimeRecoveryState
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.crashes)) throw new Error('invalid runtime recovery state')
    return { schemaVersion: 1, crashes: parsed.crashes.filter((value) => typeof value === 'string') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
      return { schemaVersion: 1, crashes: [] }
    }
    return { schemaVersion: 1, crashes: [] }
  }
}

export async function recordRuntimeCrash(
  file: string,
  options: { now?: Date; windowMs?: number; maxRestarts?: number } = {},
): Promise<RuntimeRestartDecision> {
  const now = options.now ?? new Date()
  const windowMs = options.windowMs ?? 60_000
  const maxRestarts = options.maxRestarts ?? 3
  const state = await readState(file)
  const cutoff = now.getTime() - windowMs
  const crashes = state.crashes.filter((value) => {
    const time = Date.parse(value)
    return Number.isFinite(time) && time >= cutoff
  })
  const attempt = crashes.length + 1
  crashes.push(now.toISOString())
  await writeAtomic(file, { schemaVersion: 1, crashes })
  const delayMs = Math.min(15_000, 1_000 * 2 ** Math.max(0, attempt - 1))
  return { allowed: attempt <= maxRestarts, attempt, delayMs }
}

export async function clearRuntimeCrashHistory(file: string): Promise<void> {
  await rm(file, { force: true })
}
