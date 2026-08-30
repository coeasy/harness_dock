import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  commitManagedRuntimeCandidate,
  defaultManagedRuntimeStatePath,
  failManagedRuntimeCandidate,
  markManagedRuntimeVerifying,
  readManagedRuntimeState,
  selectManagedRuntimeVersion,
  shouldStageManagedRuntime,
  stageManagedRuntimeCandidate,
} from '../src/managed-runtime.ts'

const roots: string[] = []

async function statePath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harnessdock-managed-runtime-'))
  roots.push(root)
  return defaultManagedRuntimeStatePath(root)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('managed Runtime state', () => {
  it('stages a version, verifies it on reboot, then commits it as active', async () => {
    const file = await statePath()
    await stageManagedRuntimeCandidate(file, {
      currentVersion: '0.1.2',
      targetVersion: '0.1.3',
      now: new Date('2026-08-30T00:00:00.000Z'),
    })
    const staged = await readManagedRuntimeState(file)
    expect(staged).toMatchObject({
      phase: 'staged',
      activeVersion: '0.1.2',
      candidateVersion: '0.1.3',
      attempt: 0,
    })
    expect(selectManagedRuntimeVersion(staged, ['0.1.2', '0.1.3'])).toEqual({
      version: '0.1.3',
      candidate: true,
    })

    await markManagedRuntimeVerifying(file, '0.1.3')
    const committed = await commitManagedRuntimeCandidate(file, '0.1.3')
    expect(committed).toMatchObject({
      phase: 'active',
      activeVersion: '0.1.3',
      previousVersion: '0.1.2',
      attempt: 0,
    })
    expect(committed?.candidateVersion).toBeUndefined()
  })

  it('quarantines a failed candidate and falls back to the healthy active version', async () => {
    const file = await statePath()
    await stageManagedRuntimeCandidate(file, {
      currentVersion: '0.1.2',
      targetVersion: '0.1.3',
    })
    await markManagedRuntimeVerifying(file, '0.1.3')
    const failed = await failManagedRuntimeCandidate(file, '0.1.3', new Error('startup failed\nno secrets'))
    expect(failed).toMatchObject({
      phase: 'failed',
      activeVersion: '0.1.2',
      lastFailedVersion: '0.1.3',
      error: 'startup failed no secrets',
    })
    expect(selectManagedRuntimeVersion(failed, ['0.1.2', '0.1.3'])).toEqual({
      version: '0.1.2',
      candidate: false,
    })
    expect(shouldStageManagedRuntime(failed, '0.1.3')).toBe(false)
    expect(shouldStageManagedRuntime(failed, '0.1.4')).toBe(true)
  })

  it('stops retrying a verifying candidate after the configured attempt limit', async () => {
    const file = await statePath()
    await stageManagedRuntimeCandidate(file, {
      currentVersion: '0.1.2',
      targetVersion: '0.1.3',
    })
    await markManagedRuntimeVerifying(file, '0.1.3')
    const verifying = await markManagedRuntimeVerifying(file, '0.1.3')
    expect(verifying?.attempt).toBe(2)
    expect(selectManagedRuntimeVersion(verifying, ['0.1.2', '0.1.3'], 2)).toEqual({
      version: '0.1.2',
      candidate: false,
    })
  })
})
