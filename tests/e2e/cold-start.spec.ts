import { expect, test } from '@playwright/test'
import { launchApp, teardown, type LaunchResult } from './harness.ts'

declare global {
  interface Window {
    dshWindowControls?: {
      minimize(): void
      toggleMaximize(): void
      close(): void
    }
  }
}

test.describe('cold start', () => {
  test('boots the shell and loads the mock dsh UI', async () => {
    let result: LaunchResult | undefined
    try {
      result = await launchApp()
      const { app, page, mockUrl } = result

      // The main window must point at the mock dsh origin (127.0.0.1:<random port>).
      expect(page.url()).toBe(mockUrl)
      expect(mockUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+(\/|$)/)

      // Window title follows the loaded page title -> "HarnessDock".
      await expect(page).toHaveTitle(/HarnessDock/)

      // The mock server's body is actually rendered.
      await expect(page.getByRole('heading', { name: 'Mock DSH', exact: true })).toBeVisible()

      // The custom caption bar + window controls (min/max/close) are injected
      // and their IPC bridge is wired to the main process.
      const probe = await page.evaluate(() => ({
        hasBridge: typeof window.dshWindowControls === 'object',
        hasCaption: !!document.getElementById('dsh-caption'),
      }))
      expect(probe.hasBridge).toBe(true)
      expect(probe.hasCaption).toBe(true)
      await expect(page.locator('#dsh-caption')).toBeVisible()
      await expect(page.locator('#dsh-caption .cap-btn[data-action="minimize"]')).toBeVisible()
      await expect(
        page.locator('#dsh-caption .cap-btn[data-action="toggle-maximize"]'),
      ).toBeVisible()
      await expect(page.locator('#dsh-caption .cap-btn[data-action="close"]')).toBeVisible()
      const bridge = await page.evaluate(() => ({
        hasControls: typeof window.dshWindowControls === 'object',
        actions:
          typeof window.dshWindowControls === 'object' &&
          (['minimize', 'toggleMaximize', 'close'] as const).every(
            (k) => typeof (window.dshWindowControls as Record<string, unknown>)[k] === 'function',
          ),
      }))
      expect(bridge.hasControls).toBe(true)
      expect(bridge.actions).toBe(true)

      // The main process survived boot and still owns a BrowserWindow.
      const state = await app.evaluate(({ BrowserWindow }) => ({
        windowCount: BrowserWindow.getAllWindows().length,
      }))
      expect(state.windowCount).toBeGreaterThanOrEqual(1)

      // The mock dsh http server answers a dedicated status probe.
      const status = await fetch(`${mockUrl}/__mock/status`, {
        signal: AbortSignal.timeout(3000),
      })
      expect(status.ok).toBe(true)
      expect((await status.json()) as { ok: boolean }).toMatchObject({ ok: true })
    } finally {
      await teardown(result)
    }
  })
})
