// Playwright e2e configuration for HarnessDock desktop smoke tests.
//
// The harness page lives inside a WebView2 (Windows), WKWebView (macOS) or
// WebKitGTK (Linux) window, not a plain Chromium tab. Playwright reaches it
// through the WebView's Chrome DevTools Protocol endpoint, which HarnessDock
// enables when `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
// (or the platform equivalent) carries `--remote-debugging-port`.
//
// Tests are serial, single-project, and expect a pre-built desktop binary.
// Example (PowerShell):
//
//   $env:HARNESS_DOCK_E2E_BIN = "apps\tauri\src-tauri\target\debug\harnessdock-tauri.exe"
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333 --remote-allow-origins=*"
//   pnpm --filter @dsh/e2e-tests e2e --project=desktop
import { defineConfig } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // Keep Playwright's own cleanup outside the repo so the safe-delete guard
  // (bulk-confirm threshold) is never triggered by test artifact churn.
  outputDir: path.join(os.tmpdir(), 'harnessdock-e2e-results'),
  projects: [
    {
      name: 'desktop',
      testMatch: /smoke\.spec\.ts/,
    },
  ],
  use: {
    trace: 'retain-on-failure',
  },
})