export interface RuntimeTransitionHooks {
  stop(): Promise<void>
  activate(): Promise<void>
  start(): Promise<void>
  health(): Promise<{ ok: boolean; message?: string }>
  rollback(): Promise<void>
}

/**
 * Execute a runtime activation as one recoverable transaction.
 *
 * The host keeps its cross-process lease while the runtime is stopped. If the
 * new runtime fails to start or fails health verification, the previous
 * selection is restored and started before the original activation error is
 * rethrown. A failed rollback is surfaced as an AggregateError because the
 * client can no longer claim a healthy runtime.
 */
export async function activateRuntimeWithRollback(hooks: RuntimeTransitionHooks): Promise<void> {
  await hooks.stop()
  try {
    await hooks.activate()
    await hooks.start()
    const health = await hooks.health()
    if (!health.ok) throw new Error(health.message || 'Activated runtime failed health verification')
  } catch (activationError) {
    const recoveryErrors: unknown[] = []
    await hooks.stop().catch((error) => recoveryErrors.push(error))
    await hooks.rollback().catch((error) => recoveryErrors.push(error))
    await hooks.start().catch((error) => recoveryErrors.push(error))
    if (recoveryErrors.length === 0) {
      const restoredHealth = await hooks.health().catch((error) => {
        recoveryErrors.push(error)
        return { ok: false, message: 'Rollback health verification threw' }
      })
      if (!restoredHealth.ok) {
        recoveryErrors.push(new Error(restoredHealth.message || 'Rolled-back runtime failed health verification'))
      }
    }
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [activationError, ...recoveryErrors],
        'Runtime activation failed and the previous runtime could not be restored cleanly',
      )
    }
    throw activationError
  }
}
