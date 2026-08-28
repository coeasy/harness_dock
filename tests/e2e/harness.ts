// E2E harness: builds the desktop bundle, resolves the local Electron binary,
// generates a mock-dsh.cmd wrapper + an isolated app dir (unique app name ->
// unique userData under the real %APPDATA%), prepares the env, launches the app
// with Playwright's `_electron`, and exposes small helpers used by the specs.
//
// NOTE on userData isolation: overriding APPDATA breaks Electron's
// `app.getPath('userData')` on Windows (it throws "Failed to get 'userData'
// path", which makes `requestSingleInstanceLock()` fail and the app quit at
// boot). So isolation is achieved via a per-test package.json `name`: userData
// resolves to `<real %APPDATA%>/<name>`, which is unique per test and cleaned up
// on teardown.
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron, type ElectronApplication, type Page } from '@playwright/test'

const here = path.dirname(fileURLToPath(import.meta.url))
export const repoRoot = path.resolve(here, '../..')
const desktopDir = path.join(repoRoot, 'apps', 'desktop')
export const distMainJs = path.join(desktopDir, 'dist', 'main.js')
const distPreloadJs = path.join(desktopDir, 'dist', 'preload.js')
// The desktop main bundle is tested directly (dist/main.js). Its esbuild ESM
// banner already injects a `require` (createRequire) so the electron-updater
// CJS chain boots under Electron's ESM main process.
const mockScriptPath = path.join(here, 'mock-dsh.mjs')

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Rebuilds apps/desktop/dist when it is missing or older than the desktop src /
 * the shared packages it bundles. `pretest` already runs the bundle, so this is
 * only a safety net for `npx playwright test` style direct invocations.
 */
export function ensureDesktopBundle(): void {
  const sources = [
    path.join(desktopDir, 'src', 'main.ts'),
    path.join(desktopDir, 'src', 'preload.ts'),
    path.join(desktopDir, 'src', 'boot', 'boot-flow.ts'),
    path.join(desktopDir, 'src', 'boot', 'crash-guard.ts'),
    path.join(desktopDir, 'src', 'window', 'main-window.ts'),
    path.join(repoRoot, 'packages', 'bootstrap', 'src', 'runtime.ts'),
    path.join(repoRoot, 'packages', 'client-runtime', 'src', 'runtime.ts'),
  ]
  const main = statSync(distMainJs, { throwIfNoEntry: false })
  const preload = statSync(distPreloadJs, { throwIfNoEntry: false })
  let stale = !main || !preload
  if (!stale) {
    const newestSource = Math.max(
      ...sources.map((file) => statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0),
    )
    stale = Math.min(main!.mtimeMs, preload!.mtimeMs) < newestSource
  }
  if (!stale) return
  const result = spawnSync('pnpm', ['--filter', '@dsh/desktop', 'bundle'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    throw new Error(
      `desktop bundle failed (exit ${result.status})\n${result.stderr?.toString() ?? ''}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Electron binary resolution
// ---------------------------------------------------------------------------

/** Resolves the real Electron executable shipped by the desktop devDependency. */
export function resolveElectronPath(): string {
  const require = createRequire(path.join(desktopDir, 'package.json'))
  return require('electron') as string
}

// ---------------------------------------------------------------------------
// App dir + mock dsh bootstrap
// ---------------------------------------------------------------------------

export interface LaunchOptions {
  /**
   * App name (package.json `name`). Defaults to a fresh random name -> fresh
   * userData per launch. Pass the SAME name twice to share userData (used by
   * the single-instance test: the second launch must fail the lock).
   */
  appName?: string
  /** Extra environment overrides layered on top of the standard test env. */
  envOverrides?: Record<string, string>
}

export interface LaunchResult {
  app: ElectronApplication
  page: Page
  mockUrl: string
  tmpDir: string
  appName: string
}

function realUserDataDir(appName: string): string {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, appName)
}

/**
 * Full cold-start launch: temp dir + app package.json + mock command +
 * isolated env + Electron. Call `teardown()` afterwards.
 */
export async function launchApp(options: LaunchOptions = {}): Promise<LaunchResult> {
  ensureDesktopBundle()
  const appName = options.appName ?? `dsh-e2e-${randomUUID()}`
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-e2e-app-'))
  await createMockCommand(tmpDir)
  // Per-test app: package.json (drives the app name -> unique userData) whose
  // `main` delegates to the desktop's official dist/main.js.
  await writeFile(
    path.join(tmpDir, 'package.json'),
    JSON.stringify(
      { name: appName, version: '0.0.0', private: true, main: 'index.mjs' },
      null,
      2,
    ),
    'utf8',
  )
  await writeFile(
    path.join(tmpDir, 'index.mjs'),
    `await import(${JSON.stringify(pathToFileURL(distMainJs).href)})\n`,
    'utf8',
  )
  const app = await _electron.launch({
    executablePath: resolveElectronPath(),
    args: [tmpDir],
    cwd: repoRoot,
    env: buildTestEnv(tmpDir, appName, options.envOverrides),
    timeout: 60_000,
  })
  try {
    const page = await waitForMainWindow(app)
    const mockUrl = page.url()
    return { app, page, mockUrl, tmpDir, appName }
  } catch (error) {
    await closeApp(app)
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    await rm(realUserDataDir(appName), { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/** Tears the app down and removes both the temp dir and the userData dir. */
export async function teardown(result: LaunchResult | undefined): Promise<void> {
  if (!result) return
  await closeApp(result.app)
  await rm(result.tmpDir, { recursive: true, force: true }).catch(() => undefined)
  await rm(realUserDataDir(result.appName), { recursive: true, force: true }).catch(
    () => undefined,
  )
}

/** Writes the mock-dsh.cmd wrapper into `tmpDir`; returns its absolute path. */
export async function createMockCommand(tmpDir: string): Promise<string> {
  const cmdFile = path.join(tmpDir, 'mock-dsh.cmd')
  await writeFile(cmdFile, `@echo off\r\nnode "${mockScriptPath}"\r\n`, 'utf8')
  return cmdFile
}

/**
 * Builds the environment handed to the Electron app. Note that APPDATA is NOT
 * overridden (it breaks Electron's userData resolution on Windows); isolation
 * comes from the unique app name instead.
 */
export function buildTestEnv(
  tmpDir: string,
  appName: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    DSH_RUNTIME: 'local',
    DSH_BIN: path.join(tmpDir, 'mock-dsh.cmd'),
    DSH_TRAY: '0',
    DSH_MOCK_PID_FILE: path.join(tmpDir, 'mock.pid'),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

const MOCK_URL_RE = /^http:\/\/127\.0\.0\.1:\d+/

/**
 * Waits until a BrowserWindow whose URL is the mock dsh origin appears. The
 * splash screen (data: URL) may be the first window to show, so we never rely
 * on `firstWindow()` alone.
 */
export async function waitForMainWindow(
  app: ElectronApplication,
  timeoutMs = 40_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  try {
    await app.firstWindow({ timeout: 15_000 })
  } catch (error) {
    lastError = error
  }
  while (Date.now() < deadline) {
    try {
      const page = app.windows().find((window) => MOCK_URL_RE.test(window.url()))
      if (page) return page
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  throw new Error(
    `main window never reached the mock dsh URL within ${timeoutMs}ms` +
      (lastError ? ` (last error: ${String(lastError)})` : ''),
  )
}

/** Safe app close; `app.close()` drives the graceful app.quit() path. */
export async function closeApp(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return
  // If the app already quit (e.g. the caption close button with DSH_TRAY=0),
  // Playwright's close() would wait forever on an exited process.
  try {
    const proc = app.process()
    if (proc && proc.exitCode !== null) return
  } catch {
    // process() may throw if the app is gone
  }
  // Race close() against a timeout: an already-exited app can make close()
  // hang even when exitCode is still reported as null.
  await Promise.race([
    app.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ])
}

// ---------------------------------------------------------------------------
// Process / liveness helpers (Windows)
// ---------------------------------------------------------------------------

/** Reads the mock dsh node pid from the file it wrote (DSH_MOCK_PID_FILE). */
export async function readMockPid(tmpDir: string): Promise<number | undefined> {
  try {
    const raw = await readFile(path.join(tmpDir, 'mock.pid'), 'utf8')
    const pid = Number(raw.trim())
    return Number.isFinite(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/** OS-level liveness probe (matches client-runtime's isProcessAlive). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface ProcessInfo {
  pid: number
  name: string
  commandLine: string
}

/**
 * Lists Windows processes whose name is in `names` (default: the mock dsh tree
 * — node.exe runs mock-dsh.mjs, cmd.exe runs the mock-dsh.cmd wrapper) and
 * whose command line contains `needle` (CIM query). Used to prove the mock dsh
 * tree is really gone after quit. Restricting to node/cmd avoids false
 * positives from unrelated shells (e.g. a test runner shell whose own command
 * line happens to mention "mock-dsh").
 */
export async function listProcessesMatching(
  needle: string,
  names: string[] = ['node.exe', 'cmd.exe'],
): Promise<ProcessInfo[]> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const nameFilter = names.map((n) => `$_.Name -eq '${n}'`).join(' -or ')
  const script = [
    `Get-CimInstance Win32_Process |`,
    `Where-Object { (${nameFilter}) -and $_.CommandLine -and $_.CommandLine -like '*${needle}*' -and $_.ProcessId -ne $PID } |`,
    `Select-Object ProcessId, Name, CommandLine |`,
    `ConvertTo-Json -Compress`,
  ].join(' ')
  const { stdout } = await exec('powershell', ['-NoProfile', '-Command', script], {
    windowsHide: true,
  })
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed) as unknown
  const items = Array.isArray(parsed) ? parsed : [parsed]
  return items.map((item) => ({
    pid: Number((item as { ProcessId: number }).ProcessId),
    name: String((item as { Name: string }).Name),
    commandLine: String((item as { CommandLine: string }).CommandLine),
  }))
}

/** Polls an http URL until it stops answering (connection refused). */
export async function waitForHttpDown(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1500) })
    } catch {
      return
    }
    await sleep(300)
  }
  throw new Error(`endpoint still reachable after ${timeoutMs}ms: ${url}`)
}
