import { expect, test } from '@playwright/test'
import { launchApp, teardown, type LaunchResult } from './harness.ts'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function waitFor(
  probe: () => Promise<boolean>,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return
    await sleep(200)
  }
  throw new Error(`waitFor(${label}) timed out`)
}

test.describe('window controls (caption bar buttons)', () => {
  test('minimize / maximize / close buttons work and stay responsive', async () => {
    // Use the default tray behavior (close hides instead of quitting) so the
    // app stays alive for a clean teardown; the window controls are identical.
    let result: LaunchResult | undefined
    try {
      result = await launchApp({ envOverrides: { DSH_TRAY: '1' } })
      const { app, page } = result

      const sel = (action: string) => `#dsh-caption .cap-btn[data-action="${action}"]`
      await expect(page.locator(sel('minimize'))).toBeVisible()
      await expect(page.locator(sel('toggle-maximize'))).toBeVisible()
      await expect(page.locator(sel('close'))).toBeVisible()

      // evaluate-dispatched clicks: Playwright's click()/dispatchEvent() wait on
      // the renderer, which stalls while the window is minimized.
      const tap = (action: string) =>
        page.evaluate((a) => {
          const el = document.querySelector(`#dsh-caption .cap-btn[data-action="${a}"]`)
          if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        }, action)

      const min = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized() ?? false)
      const max = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false)
      const hidden = () => app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0]
        return w ? !w.isVisible() : true
      })
      const restore = () =>
        app.evaluate(({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows()[0]
          w?.restore(); w?.show(); w?.focus()
        })

      // 1. minimize via the caption button
      await tap('minimize')
      await waitFor(min, 'minimize via button')
      await restore()
      await waitFor(async () => !(await min()), 'restored')

      // 2. maximize via the caption button
      await tap('toggle-maximize')
      await waitFor(max, 'maximize via button')

      // 3. restore via the caption button
      await tap('toggle-maximize')
      await waitFor(async () => !(await max()), 'unmaximize via button')

      // 4. buttons still respond after the min/max cycle
      await tap('minimize')
      await waitFor(min, 'minimize after cycle')
      await restore()
      await waitFor(async () => !(await min()), 'restored again')

      // 5. close via the caption button hides to tray (DSH_TRAY=1)
      await tap('close')
      await waitFor(hidden, 'window hidden via close button')
    } finally {
      await teardown(result)
    }
  })
})
