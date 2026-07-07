import { contextBridge, ipcRenderer } from "electron"

interface BuiltinServerStatus {
  enabled: boolean
  running: boolean
  phase: "idle" | "checking" | "downloading" | "starting" | "running" | "error"
  message: string
  serverURL: string
  version: string
}

contextBridge.exposeInMainWorld("veloceDesktop", {
  getBuiltinServerStatus: () => ipcRenderer.invoke("builtin-server:get-status") as Promise<BuiltinServerStatus>,
  setBuiltinServerEnabled: (enabled: boolean) => ipcRenderer.invoke("builtin-server:set-enabled", enabled) as Promise<BuiltinServerStatus>,
  onBuiltinServerStatus: (callback: (status: BuiltinServerStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: BuiltinServerStatus) => callback(status)
    ipcRenderer.on("builtin-server:status", listener)
    return () => ipcRenderer.off("builtin-server:status", listener)
  },
})
