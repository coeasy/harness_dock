export type UpdateTarget = 'host' | 'runtime' | 'plugin'

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'stopping-runtime'
  | 'installing'
  | 'restart-required'
  | 'restarting'
  | 'succeeded'
  | 'failed'
  | 'rolling-back'

export interface UpdateSnapshot {
  target: UpdateTarget
  phase: UpdatePhase
  currentVersion?: string
  nextVersion?: string
  progress?: number
  error?: string
  updatedAt: string
}

const TRANSITIONS: Record<UpdatePhase, readonly UpdatePhase[]> = {
  idle: ['checking'],
  checking: ['idle', 'available', 'failed'],
  available: ['downloading', 'idle', 'failed'],
  downloading: ['verifying', 'failed'],
  verifying: ['ready', 'failed'],
  ready: ['stopping-runtime', 'installing', 'idle', 'failed'],
  'stopping-runtime': ['installing', 'failed'],
  installing: ['restart-required', 'succeeded', 'rolling-back', 'failed'],
  'restart-required': ['restarting', 'rolling-back', 'failed'],
  restarting: ['succeeded', 'rolling-back', 'failed'],
  succeeded: ['idle', 'checking'],
  failed: ['checking', 'rolling-back', 'idle'],
  'rolling-back': ['restart-required', 'succeeded', 'failed'],
}

export class InvalidUpdateTransitionError extends Error {
  constructor(readonly from: UpdatePhase, readonly to: UpdatePhase) {
    super(`Invalid update state transition: ${from} -> ${to}`)
    this.name = 'InvalidUpdateTransitionError'
  }
}

export function canTransitionUpdate(from: UpdatePhase, to: UpdatePhase): boolean {
  return TRANSITIONS[from].includes(to)
}

export function transitionUpdate(
  current: UpdateSnapshot,
  next: Omit<Partial<UpdateSnapshot>, 'target'> & { phase: UpdatePhase },
  now: () => Date = () => new Date(),
): UpdateSnapshot {
  if (!canTransitionUpdate(current.phase, next.phase)) {
    throw new InvalidUpdateTransitionError(current.phase, next.phase)
  }

  return {
    ...current,
    ...next,
    target: current.target,
    updatedAt: now().toISOString(),
  }
}

export function initialUpdateSnapshot(target: UpdateTarget, now: () => Date = () => new Date()): UpdateSnapshot {
  return {
    target,
    phase: 'idle',
    updatedAt: now().toISOString(),
  }
}
