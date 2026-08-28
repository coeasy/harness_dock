import { spawn } from 'node:child_process'
import { expect, test } from '@playwright/test'
import {
  buildTestEnv,
  resolveElectronPath,
  teardown,
  launchApp,
  type LaunchResult,
} from './harness.ts'

test.describe('single instance', () => {
  test('a second launch with the same user data exits immediately', async () => {
    let result: LaunchResult | undefined
    try {
      // appName is fixed so both launches share the exact same userData dir ->
      // the first instance holds the single-instance lock.
      const appName = `dsh-e2e-si-${Date.now()}`
      result = await launchApp({ appName })
      const { app, mockUrl, tmpDir } = result
      await expect(app.firstWindow()).not.toBeNull()

      // Launch a second raw Electron instance with the same app dir (same name,
      // same userData). The lock is held by the first app, so this process exits
      // (code 0) without starting a second dsh.
      const second = spawn(resolveElectronPath(), [tmpDir], {
        cwd: tmpDir,
        env: buildTestEnv(tmpDir, appName),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const exitCode = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          second.kill()
          resolve(null)
        }, 20_000)
        second.once('error', () => {
          clearTimeout(timer)
          resolve(null)
        })
        second.once('exit', (code) => {
          clearTimeout(timer)
          resolve(code)
        })
      })
      expect(exitCode, 'second instance should exit promptly (got null = timeout)').toBe(0)

      // The first instance is untouched: its mock dsh is still reachable and it
      // still owns its main window.
      const status = await fetch(`${mockUrl}/__mock/status`, { signal: AbortSignal.timeout(3000) })
      expect(status.ok).toBe(true)
      const windowCount = await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      )
      expect(windowCount).toBeGreaterThanOrEqual(1)
    } finally {
      await teardown(result)
    }
  })
})
