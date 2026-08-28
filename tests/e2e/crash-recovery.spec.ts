import { expect, test } from '@playwright/test'
import { launchApp, teardown, type LaunchResult } from './harness.ts'

test.describe('renderer crash recovery', () => {
  test('auto-reloads the window after a renderer crash and keeps the dsh child alive', async () => {
    let result: LaunchResult | undefined
    try {
      result = await launchApp()
      const { app, page, mockUrl } = result
      await expect(page.getByRole('heading', { name: 'Mock DSH', exact: true })).toBeVisible()

      // The mock has served the initial HTML once so far.
      const before = await readStatus(mockUrl)
      expect(before.htmlRequests).toBeGreaterThanOrEqual(1)

      // Crash the renderer. forcefullyCrashRenderer() produces a real
      // `render-process-gone` (reason: 'killed') that the shell's auto-recovery
      // reacts to. NOTE: after the crash, Playwright's ElectronApplication
      // cannot observe the reloaded page (its crashed Page reports "Target
      // crashed"), so recovery is asserted via process/dsh/mock liveness and the
      // mock seeing a second HTML request (i.e. the auto-reload actually ran).
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().startsWith('http://127.0.0.1'),
        )
        if (!win) throw new Error('main window not found before crash')
        win.webContents.forcefullyCrashRenderer()
      })

      // 1) The main process survives the renderer crash (process handle alive).
      expect(app.process().exitCode).toBeNull()

      // 2) The mock dsh child keeps running (a renderer crash must not take the
      //    dsh process tree down).
      const status = await readStatus(mockUrl)
      expect(status.ok).toBe(true)

      // 3) The shell auto-reloads the crashed window: the mock sees a second
      //    HTML request within a generous window (recovery has reload-counting
      //    logic). This is the ground truth that the recovery actually ran.
      let recovered = false
      const deadline = Date.now() + 30_000
      let lastError: unknown
      while (Date.now() < deadline) {
        try {
          const statusNow = await readStatus(mockUrl)
          if (statusNow.htmlRequests > before.htmlRequests) {
            recovered = true
            break
          }
        } catch (error) {
          lastError = error
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      expect(
        recovered,
        `auto-reload never re-fetched the mock HTML within 30s (before=${before.htmlRequests}; ${String(lastError)})`,
      ).toBe(true)
    } finally {
      await teardown(result)
    }
  })
})

interface MockStatus {
  ok: boolean
  pid: number
  htmlRequests: number
}

async function readStatus(mockUrl: string): Promise<MockStatus> {
  const res = await fetch(`${mockUrl}/__mock/status`, { signal: AbortSignal.timeout(3000) })
  if (!res.ok) throw new Error(`mock status returned ${res.status}`)
  return (await res.json()) as MockStatus
}
