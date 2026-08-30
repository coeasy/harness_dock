import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('harnessDockMobile', {
  getStatus: (): Promise<unknown> => ipcRenderer.invoke('mobile:get-status'),
  createPairing: (): Promise<unknown> => ipcRenderer.invoke('mobile:create-pairing'),
  revokeDevice: (deviceId: string): Promise<unknown> => ipcRenderer.invoke('mobile:revoke-device', deviceId),
  revokeAll: (): Promise<unknown> => ipcRenderer.invoke('mobile:revoke-all'),
  copyText: (value: string): Promise<unknown> => ipcRenderer.invoke('mobile:copy-text', value),
})
