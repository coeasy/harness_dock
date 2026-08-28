import { expect, test } from '@playwright/test'
import {
  isProcessAlive,
  launchApp,
  listProcessesMatching,
  readMockPid,
  teardown,
  waitForHttpDown,
  type LaunchResult,
} from './harness.ts'

test.describe('graceful shutdown', () => {
  test('quit leaves no orphan mock dsh processes', async () => {
    let result: LaunchResult | undefined
    try {
      result = await launchApp()
      const { app, mockUrl, tmpDir } = result
      await expect(app.firstWindow()).not.toBeNull()

      // Record the mock dsh node pid so we can prove it is gone afterwards.
      const mockPid = await readMockPid(tmpDir)
      expect(mockPid).toBeTruthy()

      // Drive the real quit path: before-quit -> beginShutdown -> runtime.stop()
      // (shutdown ladder) -> app.exit(0). `app.close()` resolves once the app
      // has fully exited. Capture the process handle first: it becomes
      // unavailable on the ElectronApplication after close.
      const processHandle = app.process()
      const closed = app.waitForEvent('close')
      await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined)
      await closed

      // 1) The Electron main process exited cleanly (exit code 0).
      const exitCode = processHandle.exitCode ?? null
      expect(exitCode).toBe(0)

      // 2) The mock dsh http server is unreachable.
      await waitForHttpDown(mockUrl, 20_000)

      // 3) The mock dsh node process itself is dead.
      if (mockPid) {
        expect(isProcessAlive(mockPid)).toBe(false)
      }

      // 4) No process (node mock, cmd.exe wrapper) with mock-dsh in its command
      //    line is left behind anywhere on the machine.
      const survivors = await listProcessesMatching('mock-dsh')
      expect(survivors).toEqual([])
    } finally {
      await teardown(result)
    }
  })
})
