import { app, Menu, nativeImage, Tray } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { systemLocale, t } from './i18n.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')

export interface TrayRuntimeStatus {
  state: string
  version?: string
}

export interface TrayHandlers {
  onToggle(): void
  onOpenLog(): void
  onCheckUpdate(): void
  onRestartRuntime(): void
  onStopRuntime(): void
  getRuntimeStatus(): TrayRuntimeStatus
  /** open the diagnostics panel (info tab) */
  onDiagnostics(): void
  /** open the diagnostics panel on the runtime-versions tab */
  onVersions(): void
  /** open mobile pairing + active-device revocation */
  onMobileDevices(): void
  onQuit(): void
}

const handlersByTray = new WeakMap<Tray, TrayHandlers>()

function trayIcon(): Electron.NativeImage {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon-256.png')
    : path.join(repoRoot, 'apps', 'desktop', 'build', 'icon-256.png')
  const image = nativeImage.createFromPath(iconPath)
  if (!image.isEmpty()) return image
  try {
    return nativeImage.createFromBuffer(Buffer.alloc(16 * 16 * 4))
  } catch {
    return nativeImage.createEmpty()
  }
}

function zh(): boolean {
  return systemLocale().toLowerCase().startsWith('zh')
}

function mobileDevicesLabel(): string {
  return zh() ? '移动设备…' : 'Mobile devices…'
}

function runtimeLabel(status: TrayRuntimeStatus): string {
  const state = status.state || 'unknown'
  return zh() ? `运行时：${state}` : `Runtime: ${state}`
}

function runtimeVersionLabel(status: TrayRuntimeStatus): string {
  return zh()
    ? `运行时版本：${status.version ?? '未知'}`
    : `Runtime version: ${status.version ?? 'unknown'}`
}

function buildContextMenu(handlers: TrayHandlers): Electron.Menu {
  const runtime = handlers.getRuntimeStatus()
  const canStop = !['stopped', 'disconnected', 'stopping'].includes(runtime.state)
  const canRestart = !['stopping', 'restarting'].includes(runtime.state)
  return Menu.buildFromTemplate([
    { label: t('tray.toggle'), click: () => handlers.onToggle() },
    { type: 'separator' },
    { label: runtimeLabel(runtime), enabled: false },
    { label: runtimeVersionLabel(runtime), enabled: false },
    {
      label: zh() ? '重启运行时' : 'Restart runtime',
      enabled: canRestart,
      click: () => handlers.onRestartRuntime(),
    },
    {
      label: zh() ? '停止运行时' : 'Stop runtime',
      enabled: canStop,
      click: () => handlers.onStopRuntime(),
    },
    { type: 'separator' },
    { label: mobileDevicesLabel(), click: () => handlers.onMobileDevices() },
    { label: t('tray.diagnostics'), click: () => handlers.onDiagnostics() },
    { label: t('tray.versions'), click: () => handlers.onVersions() },
    { type: 'separator' },
    { label: t('tray.checkUpdate'), click: () => handlers.onCheckUpdate() },
    { label: t('tray.openLog'), click: () => handlers.onOpenLog() },
    { type: 'separator' },
    { label: t('tray.quit'), click: () => handlers.onQuit() },
  ])
}

export function refreshTray(tray: Tray): void {
  const handlers = handlersByTray.get(tray)
  if (!handlers || tray.isDestroyed()) return
  tray.setContextMenu(buildContextMenu(handlers))
}

export function createTray(handlers: TrayHandlers): Tray {
  const tray = new Tray(trayIcon())
  handlersByTray.set(tray, handlers)
  tray.setToolTip(t('tray.tooltip'))
  refreshTray(tray)
  tray.on('click', () => handlers.onToggle())
  tray.on('right-click', () => refreshTray(tray))
  return tray
}
