import path from 'node:path'
import { accessSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import * as vscode from 'vscode'
import { bootstrapRuntime, type BootstrapResult } from '@dsh/bootstrap'
import type { DshRuntime } from '@dsh/client-runtime'
import { renderHarnessWebview, renderErrorWebview } from './webview.ts'
import { HarnessSession } from './controller.ts'

const LOG_PREFIX = '[dshClient]'
const ERROR_TITLE = 'HarnessDock: Start Failed'

let session: HarnessSession | undefined
let runtime: DshRuntime | undefined
let runtimeStart: Promise<BootstrapResult | undefined> | undefined
let runtimeStop: Promise<void> | undefined
let runtimeGeneration = 0
let statusBar: vscode.StatusBarItem | undefined
const panels = new Set<vscode.WebviewPanel>()

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  session = new HarnessSession(readKeepAlive())
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusBar.command = 'dshClient.focus'
  context.subscriptions.push(statusBar)

  const open = vscode.commands.registerCommand('dshClient.open', () => void openWorkbench(context))
  const stop = vscode.commands.registerCommand('dshClient.stop', () => void stopWorkbench())
  // internal: status bar click reveals an existing panel (or starts one)
  const focus = vscode.commands.registerCommand('dshClient.focus', () => {
    const last = [...panels].pop()
    if (last) {
      last.reveal(vscode.ViewColumn.One)
    } else {
      void vscode.commands.executeCommand('dshClient.open')
    }
  })
  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('dshClient.keepAlive')) {
      session?.setKeepAlive(readKeepAlive())
    }
  })

  context.subscriptions.push(
    open,
    stop,
    focus,
    configListener,
    {
      dispose() {
        void stopRuntime('extension deactivated')
      },
    },
  )

  updateStatusBar()
}

export async function deactivate(): Promise<void> {
  await stopRuntime('extension deactivated')
}

async function openWorkbench(context: vscode.ExtensionContext): Promise<void> {
  const existingUrl = session?.readyInfo?.url
  if (existingUrl) {
    createPanel(context, existingUrl)
    return
  }
  try {
    const started = await startRuntime(context)
    if (!started) return
    createPanel(context, started.ready.url)
  } catch (error) {
    showErrorPanel(context, error)
  }
}

/**
 * Starts the shared runtime through the @dsh/bootstrap orchestration (origin →
 * mode resolution → DshRuntime → start, with last-known-good rollback on
 * failure). Concurrent open commands share one in-flight start. A stop request
 * advances runtimeGeneration so a late start result is stopped instead of
 * being published after the user already asked for shutdown.
 */
async function startRuntime(context: vscode.ExtensionContext): Promise<BootstrapResult | undefined> {
  if (runtimeStop) await runtimeStop
  if (runtimeStart) return runtimeStart

  const generation = runtimeGeneration
  const pending = startRuntimeOnce(context, generation)
  runtimeStart = pending
  try {
    return await pending
  } finally {
    if (runtimeStart === pending) runtimeStart = undefined
  }
}

async function startRuntimeOnce(
  context: vscode.ExtensionContext,
  generation: number,
): Promise<BootstrapResult | undefined> {
  const originFile = await resolveOriginFile(context)
  // bootstrap writes previous-origin.json under userDataDir; make sure it exists
  await mkdir(context.globalStorageUri.fsPath, { recursive: true })

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Starting HarnessDock…' },
    async (progress) => {
      const started = await bootstrapRuntime({
        originPath: originFile,
        pluginPath: pluginPath(context),
        packaged: context.extensionMode === vscode.ExtensionMode.Production,
        userDataDir: context.globalStorageUri.fsPath,
        readyTimeoutMs: 120_000,
        stopTimeoutMs: 12_000,
        log: (message) => console.log(`${LOG_PREFIX} ${message}`),
        onBeforeStart: ({ mode, bundledAvailable }) => {
          console.log(
            `${LOG_PREFIX} runtime mode: ${mode}${bundledAvailable ? ' (bundled, offline)' : ''}`,
          )
          progress.report({ message: `Runtime mode: ${mode}` })
        },
        onProgress: (event) => {
          if (event.stage === 'fetch' && event.percent != null) {
            progress.report({ message: `Downloading runtime ${Math.round(event.percent)}%` })
          } else if (event.stage === 'done') {
            progress.report({ message: 'Runtime ready, starting…' })
          }
        },
        onRollback: (info) => {
          console.log(`${LOG_PREFIX} rolled back dsh ${info.from} -> ${info.to}`)
          void vscode.window.showInformationMessage(
            `HarnessDock: dsh ${info.from} failed to start; rolled back to previous version ${info.to}.`,
          )
        },
      })
      return started
    },
  )

  if (generation !== runtimeGeneration) {
    console.log(`${LOG_PREFIX} discarding runtime started for stale lifecycle generation`)
    await result.runtime.stop().catch((error) => {
      console.log(
        `${LOG_PREFIX} stale runtime stop failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    return undefined
  }

  runtime = result.runtime
  session?.recordStarted({
    url: result.ready.url,
    port: result.ready.port,
    dshVersion: result.ready.dshVersion,
  })
  updateStatusBar(result.ready)
  return result
}

function createPanel(context: vscode.ExtensionContext, url: string): void {
  const panel = vscode.window.createWebviewPanel(
    'dshClient',
    'HarnessDock',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  )
  panels.add(panel)
  session?.panelOpened()
  panel.webview.html = renderHarnessWebview({ url, cspSource: panel.webview.cspSource })
  panel.onDidDispose(() => {
    panels.delete(panel)
    // keep-alive off: stop the shared runtime once the LAST panel closes
    const shouldStop = session?.panelClosed() ?? false
    if (shouldStop) void stopRuntime('last panel closed (keep-alive off)')
  })
}

function showErrorPanel(context: vscode.ExtensionContext, error: unknown): void {
  const panel = vscode.window.createWebviewPanel(
    'dshClientError',
    ERROR_TITLE,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  )
  panels.add(panel)
  session?.panelOpened()
  const message = error instanceof Error ? error.message : String(error)
  panel.webview.html = renderErrorWebview({
    message,
    retry: true,
    logHint: '详细日志请查看输出面板（HarnessDock / dshClient 前缀）。',
    cspSource: panel.webview.cspSource,
  })
  panel.webview.onDidReceiveMessage((received) => {
    if (received?.type === 'retry') {
      void panel.dispose()
      void vscode.commands.executeCommand('dshClient.open')
    }
  })
  panel.onDidDispose(() => {
    panels.delete(panel)
    session?.panelClosed()
  })
  updateStatusBar()
}

async function stopWorkbench(): Promise<void> {
  session?.stopRequested()
  for (const panel of [...panels]) {
    panel.dispose()
  }
  panels.clear()
  await stopRuntime('dshClient.stop')
}

async function stopRuntime(reason: string): Promise<void> {
  if (runtimeStop) return runtimeStop
  const pending = stopRuntimeOnce(reason)
  runtimeStop = pending
  try {
    await pending
  } finally {
    if (runtimeStop === pending) runtimeStop = undefined
  }
}

async function stopRuntimeOnce(reason: string): Promise<void> {
  session?.stopRequested()
  runtimeGeneration += 1

  // A start owns its child before publishing it to `runtime`. Wait for that
  // bounded startup to settle so generation invalidation can stop a late child
  // rather than losing it between the start and stop paths.
  const starting = runtimeStart
  if (starting) {
    await starting.catch((error) => {
      console.log(
        `${LOG_PREFIX} in-flight start ended during stop: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  const current = runtime
  runtime = undefined
  if (current) {
    console.log(`${LOG_PREFIX} stopping runtime (${reason})`)
    try {
      await current.stop()
    } catch (error) {
      console.log(
        `${LOG_PREFIX} stop failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  updateStatusBar()
}

function updateStatusBar(ready?: { dshVersion: string; port: number }): void {
  if (!statusBar) return
  if (ready) {
    statusBar.text = `$(server-process) HarnessDock: dsh ${ready.dshVersion} :${ready.port}`
    statusBar.tooltip = 'HarnessDock runtime running — click to focus a panel'
    statusBar.show()
  } else {
    statusBar.text = '$(server-process) HarnessDock: stopped'
    statusBar.tooltip = 'HarnessDock is not running — click to start'
    statusBar.show()
  }
}

function readKeepAlive(): boolean {
  return vscode.workspace.getConfiguration('dshClient').get<boolean>('keepAlive', false)
}

function pluginPath(context: vscode.ExtensionContext): string {
  return (
    packedPlugin(context) ??
    path.join(context.extensionPath, '../../packages/plugin-embedded-client/lib/index.js')
  )
}

function packedPlugin(context: vscode.ExtensionContext): string | undefined {
  const packed = path.join(context.extensionPath, 'resources', 'plugin-embedded-client', 'index.js')
  try {
    accessSync(packed)
    return packed
  } catch {
    return undefined
  }
}

async function resolveOriginFile(context: vscode.ExtensionContext): Promise<string> {
  const packed = path.join(context.extensionPath, 'resources', 'origin.json')
  const dev = path.join(context.extensionPath, '../../packages/docs-sync/origin.json')
  return (await fileExists(packed)) ? packed : dev
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const { access } = await import('node:fs/promises')
    await access(filePath)
    return true
  } catch {
    return false
  }
}
