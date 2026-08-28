import { contextBridge, ipcRenderer } from 'electron'

/**
 * Diagnostics panel preload (E1/E2): exposes a thin `dshDiagnostics` bridge
 * over ipcRenderer.invoke. The panel window is sandboxed + contextIsolated, so
 * the preload is the only channel to the main process.
 */
contextBridge.exposeInMainWorld('dshDiagnostics', {
  getInfo: (): Promise<unknown> => ipcRenderer.invoke('diagnostics:get-info'),
  listCachedVersions: (): Promise<unknown> => ipcRenderer.invoke('diagnostics:list-versions'),
  cleanOldVersions: (): Promise<unknown> => ipcRenderer.invoke('diagnostics:clean-old'),
  tailLog: (): Promise<unknown> => ipcRenderer.invoke('diagnostics:tail-log'),
  exportDiagnostics: (): Promise<unknown> => ipcRenderer.invoke('diagnostics:export'),
  switchVersion: (version: string): Promise<unknown> =>
    ipcRenderer.invoke('diagnostics:switch-version', version),
  clearOverride: (): Promise<unknown> => ipcRenderer.invoke('diagnostics:clear-override'),
  openLog: (): Promise<unknown> => ipcRenderer.invoke('diagnostics:open-log'),
  restart: (): Promise<unknown> => ipcRenderer.invoke('diagnostics:restart'),
})
