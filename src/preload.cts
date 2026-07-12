import { contextBridge, ipcRenderer } from "electron"

interface BuiltinServerStatus {
  enabled: boolean
  running: boolean
  phase: "idle" | "checking" | "downloading" | "starting" | "running" | "error"
  message: string
  serverURL: string
  version: string
}

interface StartConnectorInput {
  serverURL: string
  token: string
  mode: "platform" | "web_server"
  webPort?: number
}

interface StartConnectorResult {
  ok: boolean
  message: string
  version: string
}

interface DesktopProcessStatus {
  generatedAt: string
  processes: Array<{
    id: string
    kind: "builtin-server" | "connector"
    running: boolean
    phase: "idle" | "checking" | "downloading" | "starting" | "running" | "error"
    message: string
    pid: number | null
    version: string
    serverURL?: string
    mode?: string
    enabled?: boolean
    startedAt?: string
  }>
}

interface DesktopSettings {
  httpProxy: string
  builtinServerPath: string
  connectorPath: string
  preparedUpdate?: {
    tagName: string
    assetName: string
    filePath: string
  } | null
}

interface DesktopUpdateResult {
  state: "ready" | "not_available" | "error"
  message: string
  version: string
  filePath?: string
}

interface DesktopTab {
  id: string
  title: string
  serverURL: string
  path: string
}

contextBridge.exposeInMainWorld("veloceDesktop", {
  getBuiltinServerStatus: () => ipcRenderer.invoke("builtin-server:get-status") as Promise<BuiltinServerStatus>,
  getDesktopProcessStatus: () => ipcRenderer.invoke("desktop-processes:get-status") as Promise<DesktopProcessStatus>,
  terminateDesktopProcess: (id: string) => ipcRenderer.invoke("desktop-processes:terminate", id) as Promise<DesktopProcessStatus>,
  getDesktopSettings: () => ipcRenderer.invoke("desktop-settings:get") as Promise<DesktopSettings>,
  saveDesktopSettings: (settings: DesktopSettings) => ipcRenderer.invoke("desktop-settings:save", settings) as Promise<DesktopSettings>,
  chooseDesktopFile: () => ipcRenderer.invoke("desktop-settings:choose-file") as Promise<string>,
  getDesktopSystemInfo: () => ipcRenderer.invoke("desktop:get-system-info") as Promise<{ hostname: string; platform: string }>,
  openInVSCode: (workspacePath: string) => ipcRenderer.invoke("desktop:open-in-vscode", workspacePath) as Promise<{ ok: boolean; message: string }>,
  runDesktopMenuAction: (action: "new-window" | "quit" | "close-window" | "copy" | "paste" | "cut" | "delete" | "undo" | "redo") => ipcRenderer.invoke("desktop:menu-action", action) as Promise<{ ok: boolean }>,
  openDesktopLink: (target: "official-site" | "github") => ipcRenderer.invoke("desktop:open-link", target) as Promise<{ ok: boolean }>,
  checkDesktopUpdate: () => ipcRenderer.invoke("desktop-update:check") as Promise<DesktopUpdateResult>,
  installPreparedDesktopUpdate: () => ipcRenderer.invoke("desktop-update:install-prepared") as Promise<{ ok: boolean; message: string }>,
  getDesktopTabInitialState: () => ipcRenderer.invoke("desktop-tabs:get-initial-state") as Promise<{ windowID: number; tab: DesktopTab | null }>,
  detachDesktopTab: (input: DesktopTab & { screenX: number; screenY: number }) => ipcRenderer.invoke("desktop-tabs:detach", input) as Promise<{ moved: boolean; targetWindowID?: number }>,
  setBuiltinServerEnabled: (enabled: boolean) => ipcRenderer.invoke("builtin-server:set-enabled", enabled) as Promise<BuiltinServerStatus>,
  startConnector: (input: StartConnectorInput) => ipcRenderer.invoke("connector:start", input) as Promise<StartConnectorResult>,
  onBuiltinServerStatus: (callback: (status: BuiltinServerStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: BuiltinServerStatus) => callback(status)
    ipcRenderer.on("builtin-server:status", listener)
    return () => ipcRenderer.off("builtin-server:status", listener)
  },
  onDesktopProcessStatus: (callback: (status: DesktopProcessStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: DesktopProcessStatus) => callback(status)
    ipcRenderer.on("desktop-processes:status", listener)
    return () => ipcRenderer.off("desktop-processes:status", listener)
  },
  onDesktopTabReceived: (callback: (tab: DesktopTab) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, tab: DesktopTab) => callback(tab)
    ipcRenderer.on("desktop-tabs:received", listener)
    return () => ipcRenderer.off("desktop-tabs:received", listener)
  },
})
