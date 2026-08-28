import { app, screen } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { bootLog } from './boot-log.ts'

// ---------- window state persistence ----------
// Remember position, size, and maximized state across launches so the
// client lands where the user left it.
export type WindowState = {
  bounds?: { x: number; y: number; width: number; height: number }
  maximized?: boolean
}

function windowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json')
}

export function readWindowStateSync(): WindowState {
  try {
    const raw = readFileSync(windowStatePath(), 'utf8')
    const parsed = JSON.parse(raw) as WindowState
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    // first launch or corrupted file -- fall back to defaults
  }
  return {}
}

export function isBoundsOnScreen(b: { x: number; y: number; width: number; height: number }): boolean {
  // Reject obviously off-screen / tiny bounds (e.g. unplugged display).
  const w = Math.max(640, Math.min(b.width, 4000))
  const h = Math.max(480, Math.min(b.height, 4000))
  const rect = { x: b.x, y: b.y, width: w, height: h }
  return screen.getAllDisplays().some((d: Electron.Display) => {
    const a = d.workArea
    return (
      rect.x + rect.width > a.x &&
      rect.y + rect.height > a.y &&
      rect.x < a.x + a.width &&
      rect.y < a.y + a.height
    )
  })
}

export function writeWindowState(state: WindowState): void {
  try {
    mkdirSync(path.dirname(windowStatePath()), { recursive: true })
    writeFileSync(windowStatePath(), JSON.stringify(state, null, 2), 'utf8')
  } catch (error) {
    void bootLog(`writeWindowState failed: ${(error as Error).message}`)
  }
}
