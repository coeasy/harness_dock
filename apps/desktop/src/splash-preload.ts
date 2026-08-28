import { contextBridge, ipcRenderer } from 'electron'

/**
 * Splash preload (E4): exposes a minimal `dshSplash` bridge so the sandboxed
 * splash page can trigger main-process actions. The page is a data: URL with
 * sandbox + contextIsolation, so the only sanctioned channel is
 * contextBridge → ipcRenderer.send.
 */
contextBridge.exposeInMainWorld('dshSplash', {
  retry: (): void => ipcRenderer.send('splash:retry'),
  openLog: (): void => ipcRenderer.send('splash:open-log'),
  copyError: (): void => ipcRenderer.send('splash:copy-error'),
})
