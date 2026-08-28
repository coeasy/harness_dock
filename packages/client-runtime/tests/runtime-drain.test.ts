import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { drainOutput } from '../src/runtime.ts'

const fakeChild = (): {
  child: ChildProcessWithoutNullStreams
  stdout: PassThrough
  stderr: PassThrough
} => {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = { stdout, stderr } as unknown as ChildProcessWithoutNullStreams
  return { child, stdout, stderr }
}

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('drainOutput', () => {
  it('forwards chunks through the log callback with a [dsh] prefix', async () => {
    const { child, stdout } = fakeChild()
    const logs: string[] = []
    drainOutput(child, (message) => logs.push(message))
    stdout.write(Buffer.from('hello'))
    await until(() => logs.length === 1)
    expect(logs[0]).toBe('[dsh] hello')
  })

  it('drains > 100KB of stdout without throwing', async () => {
    const { child, stdout } = fakeChild()
    const logs: string[] = []
    drainOutput(child, (message) => logs.push(message))
    // ~150KB in 1KB chunks (each under the 2000-char limit, so content flows)
    for (let i = 0; i < 150; i += 1) stdout.write(Buffer.alloc(1024, 0x61))
    await until(() => logs.length === 150)
    expect(logs.join('').length).toBeGreaterThan(100 * 1024)
  })

  it('truncates an overlong chunk to 2000 characters', async () => {
    const { child, stdout } = fakeChild()
    const logs: string[] = []
    drainOutput(child, (message) => logs.push(message))
    stdout.write(Buffer.alloc(5000, 0x62))
    await until(() => logs.length === 1)
    expect(logs[0]!.startsWith('[dsh] ')).toBe(true)
    expect(logs[0]!.length).toBe(2000 + '[dsh] '.length)
  })

  it('attaches an empty consumer when no log is provided', () => {
    const { child, stdout, stderr } = fakeChild()
    drainOutput(child)
    // A 'data' listener switches the stream into flowing mode: the pipe is
    // being consumed even though nothing is logged.
    expect(stdout.readableFlowing).toBe(true)
    expect(stderr.readableFlowing).toBe(true)
  })

  it('mounts each child only once', async () => {
    const { child, stdout } = fakeChild()
    const logs: string[] = []
    drainOutput(child, (message) => logs.push(message))
    drainOutput(child, (message) => logs.push(message))
    expect(stdout.listenerCount('data')).toBe(1)
    stdout.write('once')
    await until(() => logs.length === 1)
    expect(logs.filter((message) => message === '[dsh] once')).toHaveLength(1)
  })
})
