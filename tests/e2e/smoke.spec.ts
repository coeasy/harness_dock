// Core-path desktop smoke test.
//
// Verifies the three symptoms that previously regressed in one pass, exactly
// like the interactive CDP probes used during development, but as a repeatable
// Playwright spec:
//
//   1. The shell bridge is installed (`window.__DSH_SHELL_BRIDGE__.apiVersion`)
//   2. The top bar spans the window (`left === 0`, `width === innerWidth`)
//   3. The Settings chrome is not stuck on "连接中" and the page has no
//      fatal runtime errors
//
// Prerequisites:
//   - A built desktop binary (HARNESS_DOCK_E2E_BIN, default target/debug)
//   - WebView2 remote debugging enabled (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS)
import { chromium, expect, test } from '@playwright/test'
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')
const defaultBin = path.join(
  repoRoot,
  'apps',
  'tauri',
  'src-tauri',
  'target',
  'debug',
  'harnessdock-tauri.exe',
)

const CDP_PORT = Number(process.env.HARNESS_DOCK_E2E_CDP_PORT ?? 9333)
const DEBUG_CDP_URL = `http://127.0.0.1:${CDP_PORT}`

let client: ChildProcess | undefined

async function waitHttp(url: string, attempts = 60): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // keep waiting
    }
    await delay(500)
  }
  throw new Error(`endpoint ${url} did not become reachable in time`)
}

test.beforeAll(async () => {
  const bin = process.env.HARNESS_DOCK_E2E_BIN ?? defaultBin
  if (!process.env.HARNESS_DOCK_E2E_BIN) {
    // Without an explicit binary, only run when the default debug build exists.
    const { access } = await import('node:fs/promises')
    try {
      await access(bin)
    } catch {
      test.skip(1, `no desktop binary at ${bin}; set HARNESS_DOCK_E2E_BIN`)
      return
    }
  }
  client = spawn(bin, [], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS ??
        `--remote-debugging-port=${CDP_PORT} --remote-allow-origins=*`,
    },
    windowsHide: true,
  })
  client.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[client] ${chunk.toString()}`)
  })
  await waitHttp(DEBUG_CDP_URL)
})

test.afterAll(async () => {
  // Kill the whole process tree: the WebView2 child processes (msedgewebview2)
  // must not linger between runs or they can hold the single-instance lock and
  // slow the next launch.
  if (client && client.pid) {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${client.pid} /T /F`, { stdio: 'ignore' })
      } else {
        client.kill('SIGTERM')
      }
    } catch {
      // already gone
    }
  }
  await delay(800)
})

test.describe.serial('HarnessDock desktop smoke', () => {
  test('harness page shows a full-bleed shell without connecting states or fatal errors', async () => {
    // The harness page lives in the WebView2 renderer, not in a Playwright-
    // launched Chromium. Connect Playwright to the WebView's CDP endpoint;
    // connectOverCDP surfaces the WebView renderer targets as contexts/pages.
    const cdpBrowser = await chromium.connectOverCDP(DEBUG_CDP_URL)
    try {
      const context = cdpBrowser.contexts()[0]
      // CDP becomes reachable slightly before the Harness WebView registers
      // its page target. Poll until the harness page appears.
      let harnessPage: import('@playwright/test').Page | undefined
      await expect
        .poll(
          () => {
            harnessPage = context
              .pages()
              .find(
                (page) =>
                  page.url().startsWith('http://127.0.0.1:') &&
                  !page.url().includes('tauri.localhost'),
              )
            return harnessPage ? true : false
          },
          { timeout: 45_000 },
        )
        .toBe(true)
      expect(harnessPage, 'a Harness Web page target must be present').toBeTruthy()

      const page = await context.newCDPSession(harnessPage!)

      // Collect runtime exceptions and console errors.
      const fatalErrors: string[] = []
      page.on('Runtime.exceptionThrown', (event) => {
        fatalErrors.push(
          (event as { exceptionDetails?: { exception?: { description?: string }; text?: string } })
            .exceptionDetails?.exception?.description ??
            (event as { exceptionDetails?: { text?: string } }).exceptionDetails?.text ??
            'unknown exception',
        )
      })
      page.on('Runtime.consoleAPICalled', (event) => {
        const called = event as {
          type?: string
          args?: Array<{ value?: unknown; description?: string }>
        }
        if (called.type === 'error') {
          const text = called.args
            ?.map((arg) => arg.value ?? arg.description ?? '')
            .join(' ') ?? ''
          fatalErrors.push(text)
        }
      })
      await page.send('Runtime.enable')

      // Wait until the shell bridge is installed.
      let bridgeVersion: number | undefined
      await expect
        .poll(async () => {
          const result = await page.send('Runtime.evaluate', {
            expression: 'window.__DSH_SHELL_BRIDGE__?.apiVersion ?? 0',
            returnByValue: true,
          })
          bridgeVersion = result.result?.value as number | undefined
          return bridgeVersion
        })
        .toBeGreaterThan(0)

      expect(bridgeVersion, 'shell bridge should report the contract version').toBe(2)

      const layout = await page.send('Runtime.evaluate', {
        expression: `(() => {
        const host = document.getElementById('dsh-harness-shell');
        const bar = host && host.shadowRoot && host.shadowRoot.querySelector('.bar');
        const rect = bar && bar.getBoundingClientRect();
        const text = document.body ? document.body.innerText : '';
        return {
          innerWidth: window.innerWidth,
          bar: rect ? { left: rect.left, width: rect.width, height: rect.height } : null,
          stuckConnecting: ['连接中', 'Connecting'].some((probe) => text.includes(probe)),
        };
      })()`,
        returnByValue: true,
      })
      const value = layout.result?.value as {
        innerWidth: number
        bar: { left: number; width: number; height: number } | null
        stuckConnecting: boolean
      }

      expect(value.bar, 'top bar must render').not.toBeNull()
      expect(value.bar!.left).toBe(0)
      expect(value.bar!.width).toBe(value.innerWidth)
      expect(value.stuckConnecting).toBe(false)
      expect(fatalErrors, 'no fatal runtime/console errors expected').toEqual([])
    } finally {
      await cdpBrowser.close()
    }
  })
})