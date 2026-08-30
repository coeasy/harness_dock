import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type ManagedRuntimePhase = 'active' | 'staged' | 'verifying' | 'failed'

export interface ManagedRuntimeState {
  schemaVersion: 1
  phase: ManagedRuntimePhase
  activeVersion?: string
  previousVersion?: string
  candidateVersion?: string
  lastFailedVersion?: string
  attempt: number
  updatedAt: string
  error?: string
}

export function defaultManagedRuntimeStatePath(userDataDir: string): string {
  return path.join(userDataDir, 'updates', 'managed-runtime.json')
}

export async function readManagedRuntimeState(file: string): Promise<ManagedRuntimeState | null> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'))
    assertManagedRuntimeState(value)
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null
    throw error
  }
}

export async function stageManagedRuntimeCandidate(
  file: string,
  input: { currentVersion?: string; targetVersion: string; now?: Date },
): Promise<ManagedRuntimeState> {
  if (!input.targetVersion) throw new Error('managed Runtime targetVersion is required')
  if (input.currentVersion === input.targetVersion) {
    throw new Error(`managed Runtime target already active: ${input.targetVersion}`)
  }
  const previous = await readManagedRuntimeState(file)
  const now = (input.now ?? new Date()).toISOString()
  const state: ManagedRuntimeState = {
    schemaVersion: 1,
    phase: 'staged',
    activeVersion: previous?.activeVersion ?? input.currentVersion,
    previousVersion: previous?.previousVersion,
    candidateVersion: input.targetVersion,
    lastFailedVersion: previous?.lastFailedVersion,
    attempt: 0,
    updatedAt: now,
  }
  await writeState(file, state)
  return state
}

export function selectManagedRuntimeVersion(
  state: ManagedRuntimeState | null,
  cachedVersions: readonly string[],
  maxAttempts = 2,
): { version: string; candidate: boolean } | null {
  if (!state) return null
  const cached = new Set(cachedVersions)
  if (
    state.candidateVersion &&
    (state.phase === 'staged' || state.phase === 'verifying') &&
    state.attempt < maxAttempts &&
    cached.has(state.candidateVersion)
  ) {
    return { version: state.candidateVersion, candidate: true }
  }
  if (state.activeVersion && cached.has(state.activeVersion)) {
    return { version: state.activeVersion, candidate: false }
  }
  return null
}

export async function markManagedRuntimeVerifying(
  file: string,
  version: string,
  now: Date = new Date(),
): Promise<ManagedRuntimeState | null> {
  const state = await readManagedRuntimeState(file)
  if (!state || state.candidateVersion !== version) return state
  const next: ManagedRuntimeState = {
    ...state,
    phase: 'verifying',
    attempt: state.attempt + 1,
    updatedAt: now.toISOString(),
    error: undefined,
  }
  await writeState(file, next)
  return next
}

export async function commitManagedRuntimeCandidate(
  file: string,
  version: string,
  now: Date = new Date(),
): Promise<ManagedRuntimeState | null> {
  const state = await readManagedRuntimeState(file)
  if (!state || state.candidateVersion !== version || state.phase !== 'verifying') return state
  const next: ManagedRuntimeState = {
    schemaVersion: 1,
    phase: 'active',
    activeVersion: version,
    previousVersion: state.activeVersion,
    lastFailedVersion: state.lastFailedVersion,
    attempt: 0,
    updatedAt: now.toISOString(),
  }
  await writeState(file, next)
  return next
}

export async function failManagedRuntimeCandidate(
  file: string,
  version: string,
  error: unknown,
  now: Date = new Date(),
): Promise<ManagedRuntimeState | null> {
  const state = await readManagedRuntimeState(file)
  if (!state || state.candidateVersion !== version) return state
  const next: ManagedRuntimeState = {
    schemaVersion: 1,
    phase: 'failed',
    activeVersion: state.activeVersion,
    previousVersion: state.previousVersion,
    lastFailedVersion: version,
    attempt: state.attempt,
    updatedAt: now.toISOString(),
    error: sanitizeError(error),
  }
  await writeState(file, next)
  return next
}

export function shouldStageManagedRuntime(
  state: ManagedRuntimeState | null,
  targetVersion: string,
): boolean {
  if (!state) return true
  if (state.activeVersion === targetVersion) return false
  if (state.candidateVersion === targetVersion && state.phase !== 'failed') return false
  if (state.lastFailedVersion === targetVersion) return false
  return true
}

export async function clearManagedRuntimeState(file: string): Promise<void> {
  await rm(file, { force: true })
}

function assertManagedRuntimeState(value: unknown): asserts value is ManagedRuntimeState {
  if (!value || typeof value !== 'object') throw new Error('managed Runtime state must be an object')
  const state = value as Partial<ManagedRuntimeState>
  if (state.schemaVersion !== 1) throw new Error('unsupported managed Runtime state schema')
  if (!['active', 'staged', 'verifying', 'failed'].includes(String(state.phase))) {
    throw new Error(`invalid managed Runtime phase: ${String(state.phase)}`)
  }
  if (!Number.isInteger(state.attempt) || (state.attempt ?? -1) < 0) {
    throw new Error('managed Runtime attempt must be a non-negative integer')
  }
  if (!state.updatedAt) throw new Error('managed Runtime state is missing updatedAt')
}

async function writeState(file: string, state: ManagedRuntimeState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rm(file, { force: true })
  await rename(temp, file)
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/[\r\n]+/g, ' ').slice(0, 2000)
}
