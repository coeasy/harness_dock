import { describe, expect, it, vi } from 'vitest'
import { activateRuntimeWithRollback } from '../src/runtime-transition.ts'

describe('runtime activation orchestration', () => {
  it('stops, activates, starts and verifies the new runtime in order', async () => {
    const order: string[] = []
    await activateRuntimeWithRollback({
      stop: vi.fn(async () => { order.push('stop') }),
      activate: vi.fn(async () => { order.push('activate') }),
      start: vi.fn(async () => { order.push('start') }),
      health: vi.fn(async () => { order.push('health'); return { ok: true } }),
      rollback: vi.fn(async () => { order.push('rollback') }),
    })
    expect(order).toEqual(['stop', 'activate', 'start', 'health'])
  })

  it('rolls back and restores the previous runtime when health fails', async () => {
    const order: string[] = []
    let healthChecks = 0
    await expect(activateRuntimeWithRollback({
      stop: vi.fn(async () => { order.push('stop') }),
      activate: vi.fn(async () => { order.push('activate') }),
      start: vi.fn(async () => { order.push('start') }),
      health: vi.fn(async () => {
        order.push('health')
        healthChecks += 1
        return healthChecks === 1 ? { ok: false, message: 'bad runtime' } : { ok: true }
      }),
      rollback: vi.fn(async () => { order.push('rollback') }),
    })).rejects.toThrow('bad runtime')
    expect(order).toEqual(['stop', 'activate', 'start', 'health', 'stop', 'rollback', 'start', 'health'])
  })
})
