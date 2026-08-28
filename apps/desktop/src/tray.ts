import { app, Menu, nativeImage, Tray } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { t } from './i18n.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')

export interface TrayHandlers {
  onToggle(): void
  onOpenLog(): void
  onCheckUpdate(): void
  /** open the diagnostics panel (info tab) */
  onDiagnostics(): void
  /** open the diagnostics panel on the runtime-versions tab */
  onVersions(): void
  onQuit(): void
}

function trayIcon(): Electron.NativeImage {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon-256.png')
    : path.join(repoRoot, 'apps', 'desktop', 'build', 'icon-256.png')
  const image = nativeImage.createFromPath(iconPath)
  if (!image.isEmpty()) return image
  try {
    // 16x16 fully transparent fallback so the Tray can always be constructed.
    return nativeImage.createFromBuffer(Buffer.alloc(16 * 16 * 4))
  } catch {
    return nativeImage.createEmpty()
  }
}

export function createTray(handlers: TrayHandlers): Tray {
  const tray = new Tray(trayIcon())
  tray.setToolTip(t('tray.tooltip'))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('tray.toggle'), click: () => handlers.onToggle() },
      { label: t('tray.diagnostics'), click: () => handlers.onDiagnostics() },
      { label: t('tray.versions'), click: () => handlers.onVersions() },
      { type: 'separator' },
      { label: t('tray.checkUpdate'), click: () => handlers.onCheckUpdate() },
      { label: t('tray.openLog'), click: () => handlers.onOpenLog() },
      { type: 'separator' },
      { label: t('tray.quit'), click: () => handlers.onQuit() },
    ]),
  )
  tray.on('click', () => handlers.onToggle())
  return tray
}
