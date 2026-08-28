import { describe, expect, it } from 'vitest'
import { collectProcessTree, collectProcessTreeViaCim } from '../src/process.ts'

describe('collectProcessTreeViaCim', () => {
  it('parses one-pid-per-line PowerShell output', async () => {
    const fakeExec = (async () => ({ stdout: '42\n7\n99\n' })) as never
    const tree = await collectProcessTreeViaCim(100, { exec: fakeExec })
    expect(tree.sort((a, b) => a - b)).toEqual([7, 42, 99])
  })

  it('drops the root pid, blank lines, and non-numeric garbage from stdout', async () => {
    const fakeExec = (async () => ({
      stdout: '100\r\n\r\n 7 \nnot-a-pid\n42\n99\r\n',
    })) as never
    const tree = await collectProcessTreeViaCim(100, { exec: fakeExec })
    expect(tree.sort((a, b) => a - b)).toEqual([7, 42, 99])
  })

  it('passes root and maxDepth into the PowerShell command', async () => {
    let script = ''
    const fakeExec = (async (_cmd: string, args: string[]) => {
      script = args[2] ?? ''
      return { stdout: '' }
    }) as never
    await collectProcessTreeViaCim(1234, { exec: fakeExec, maxDepth: 4 })
    expect(script).toContain('$roots = @(1234)')
    expect(script).toContain('$i -lt 4')
  })
})

describe('collectProcessTree wmic fallback', () => {
  it('falls back to the CIM enumeration when wmic throws', async () => {
    let powershellInvoked = false
    const fakeExec = (async (cmd: string) => {
      if (cmd === 'wmic') throw new Error('wmic unavailable')
      powershellInvoked = true
      return { stdout: '42\n7\n99\n' }
    }) as never
    const tree = await collectProcessTree(100, { exec: fakeExec })
    expect(powershellInvoked).toBe(true)
    expect(tree.sort((a, b) => a - b)).toEqual([7, 42, 99])
  })

  it('returns [] when both wmic and CIM fail', async () => {
    const fakeExec = (async () => {
      throw new Error('all enumeration failed')
    }) as never
    const tree = await collectProcessTree(100, { exec: fakeExec })
    expect(tree).toEqual([])
  })
})
