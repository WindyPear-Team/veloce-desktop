import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell } from "electron"
import { spawn, spawnSync } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import https from "node:https"
import { randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const indexPath = path.join(__dirname, "web", "index.html")
const iconPath = path.join(__dirname, "..", "assets", "logo.png")
const preloadPath = path.join(__dirname, "preload.cjs")

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let builtinServerEnabled = false
let builtinServerProcess: ChildProcess | null = null
const initialWindowTabs = new Map<number, DesktopTab>()

type BuiltinServerPhase = "idle" | "checking" | "downloading" | "starting" | "running" | "error"
type ManagedProcessKind = "builtin-server" | "connector"

interface BuiltinServerStatus {
  enabled: boolean
  running: boolean
  phase: BuiltinServerPhase
  message: string
  serverURL: string
  version: string
}

interface GitHubReleaseAsset {
  name: string
  browser_download_url: string
}

interface GitHubRelease {
  tag_name: string
  assets: GitHubReleaseAsset[]
}

interface BuiltinServerConfig {
  enabled?: boolean
}

interface PreparedDesktopUpdate {
  tagName: string
  assetName: string
  filePath: string
}

interface DesktopSettings {
  httpProxy: string
  builtinServerPath: string
  connectorPath: string
  preparedUpdate?: PreparedDesktopUpdate | null
  desktopConnectorTokens: Record<string, string>
}

interface DesktopUpdateResult {
  state: "ready" | "not_available" | "error"
  message: string
  version: string
  filePath?: string
}

interface StartConnectorInput {
  serverURL: string
  token: string
  mode: "platform" | "web_server"
  webPort?: number
  deviceID?: string
  deviceKind?: "cli" | "desktop"
  desktopInstanceID?: string
  restart?: boolean
}

interface ConnectorStatus {
  id: string
  running: boolean
  phase: BuiltinServerPhase
  message: string
  serverURL: string
  version: string
  mode: "platform" | "web_server"
  startedAt: string
  deviceID: string
  deviceKind: "cli" | "desktop"
}

interface ManagedProcessStatus {
  id: string
  kind: ManagedProcessKind
  running: boolean
  phase: BuiltinServerPhase
  message: string
  pid: number | null
  version: string
  serverURL?: string
  mode?: string
  enabled?: boolean
  startedAt?: string
}

interface DesktopProcessStatus {
  generatedAt: string
  processes: ManagedProcessStatus[]
}

interface DesktopTab {
  id: string
  title: string
  serverURL: string
  path: string
}

interface ManagedConnectorProcess {
  process: ChildProcess | null
  status: ConnectorStatus
}

let builtinServerStatus: BuiltinServerStatus = {
  enabled: false,
  running: false,
  phase: "idle",
  message: "",
  serverURL: builtinServerURL(),
  version: "",
}

const connectorProcesses = new Map<string, ManagedConnectorProcess>()
const desktopConnectorEnsureRequests = new Map<string, Promise<{ ok: boolean; message: string; version: string }>>()

let desktopSettings: DesktopSettings = {
  httpProxy: "",
  builtinServerPath: "",
  connectorPath: "",
  preparedUpdate: null,
  desktopConnectorTokens: {},
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
}

app.on("second-instance", showMainWindow)

function tokenFromURL(rawURL: string) {
  try {
    const url = new URL(rawURL)
    const queryToken = url.searchParams.get("token")
    if (queryToken) {
      return queryToken
    }
    if (url.hash.startsWith("#token=")) {
      return url.hash.slice("#token=".length)
    }
    const hashQueryIndex = url.hash.indexOf("?")
    if (hashQueryIndex >= 0) {
      return new URLSearchParams(url.hash.slice(hashQueryIndex + 1)).get("token")
    }
  } catch {
    return null
  }
  return null
}

function loadLocalApp(hash = "/login") {
  if (!mainWindow) {
    return
  }
  void mainWindow.loadFile(indexPath, { hash })
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  mainWindow.focus()
}

function veloceDataDir() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Veloce")
  }
  return path.join(os.homedir(), ".veloce")
}

function builtinServerConfigPath() {
  return path.join(veloceDataDir(), "desktop-server.json")
}

function desktopSettingsPath() {
  return path.join(veloceDataDir(), "desktop-settings.json")
}

function desktopInstanceIDPath() {
  return path.join(veloceDataDir(), "desktop-instance-id")
}

function desktopInstanceID() {
  try {
    const existing = fs.readFileSync(desktopInstanceIDPath(), "utf8").trim()
    if (/^[a-f0-9-]{36}$/i.test(existing)) {
      return existing
    }
  } catch {
    // A new installation receives an opaque random id below.
  }
  const instanceID = randomUUID()
  fs.mkdirSync(veloceDataDir(), { recursive: true })
  fs.writeFileSync(desktopInstanceIDPath(), instanceID, "utf8")
  return instanceID
}

function builtinServerRuntimeDir() {
  return path.join(veloceDataDir(), "community-data")
}

function builtinServerDBPath() {
  const configured = process.env.VELOCE_BUILTIN_SERVER_DB_PATH?.trim()
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.join(builtinServerRuntimeDir(), configured)
  }
  return path.join(builtinServerRuntimeDir(), "flai.db")
}

async function readBuiltinServerConfig() {
  try {
    const raw = await fsp.readFile(builtinServerConfigPath(), "utf8")
    return JSON.parse(raw) as BuiltinServerConfig
  } catch {
    return {}
  }
}

async function writeBuiltinServerConfig(config: BuiltinServerConfig) {
  await fsp.mkdir(veloceDataDir(), { recursive: true })
  await fsp.writeFile(builtinServerConfigPath(), JSON.stringify(config, null, 2))
}

async function readDesktopSettings() {
  try {
    const raw = await fsp.readFile(desktopSettingsPath(), "utf8")
    return normalizeDesktopSettings(JSON.parse(raw))
  } catch {
    return normalizeDesktopSettings({})
  }
}

async function writeDesktopSettings(settings: DesktopSettings) {
  desktopSettings = {
    ...normalizeDesktopSettings(settings),
    desktopConnectorTokens: desktopSettings.desktopConnectorTokens,
  }
  applyDesktopProxySettings()
  await fsp.mkdir(veloceDataDir(), { recursive: true })
  await fsp.writeFile(desktopSettingsPath(), JSON.stringify(desktopSettings, null, 2))
  return desktopSettings
}

function normalizeDesktopSettings(value: unknown): DesktopSettings {
  const item = value && typeof value === "object" ? value as Record<string, unknown> : {}
  const prepared = item.preparedUpdate && typeof item.preparedUpdate === "object"
    ? item.preparedUpdate as Record<string, unknown>
    : null
  const rawConnectorTokens = item.desktopConnectorTokens && typeof item.desktopConnectorTokens === "object"
    ? item.desktopConnectorTokens as Record<string, unknown>
    : {}
  const desktopConnectorTokens = Object.fromEntries(Object.entries(rawConnectorTokens)
    .filter(([, token]) => typeof token === "string" && token.trim())
    .map(([serverURL, token]) => [serverURL, (token as string).trim()]))
  return {
    httpProxy: typeof item.httpProxy === "string" ? item.httpProxy.trim() : "",
    builtinServerPath: typeof item.builtinServerPath === "string" ? item.builtinServerPath.trim() : "",
    connectorPath: typeof item.connectorPath === "string" ? item.connectorPath.trim() : "",
    preparedUpdate: prepared && typeof prepared.tagName === "string" && typeof prepared.assetName === "string" && typeof prepared.filePath === "string"
      ? { tagName: prepared.tagName, assetName: prepared.assetName, filePath: prepared.filePath }
      : null,
    desktopConnectorTokens,
  }
}

function desktopSettingsForRenderer() {
  const { desktopConnectorTokens: _tokens, ...settings } = desktopSettings
  return settings
}

function applyDesktopProxySettings() {
  const proxy = desktopSettings.httpProxy.trim()
  if (proxy) {
    process.env.HTTP_PROXY = proxy
    process.env.HTTPS_PROXY = proxy
    process.env.http_proxy = proxy
    process.env.https_proxy = proxy
  } else {
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
    delete process.env.http_proxy
    delete process.env.https_proxy
  }
}

function desktopProcessEnv() {
  const env = { ...process.env }
  const proxy = desktopSettings.httpProxy.trim()
  if (proxy) {
    env.HTTP_PROXY = proxy
    env.HTTPS_PROXY = proxy
    env.http_proxy = proxy
    env.https_proxy = proxy
  }
  return env
}

function builtinServerPort() {
  return (process.env.VELOCE_BUILTIN_SERVER_PORT || process.env.PORT || "8080").trim()
}

function builtinServerURL() {
  return `http://localhost:${builtinServerPort()}`
}

function builtinServerEnv() {
  return {
    ...desktopProcessEnv(),
    PORT: builtinServerPort(),
    DB_PATH: builtinServerDBPath(),
  }
}

async function resolveBuiltinServerURL(pid?: number) {
  if (pid) {
    const port = await waitForProcessListenPort(pid, 8000)
    if (port) {
      return `http://localhost:${port}`
    }
  }
  return builtinServerURL()
}

async function waitForProcessListenPort(pid: number, timeoutMs: number) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const port = detectProcessListenPort(pid)
    if (port) {
      return port
    }
    await sleep(250)
  }
  return null
}

function detectProcessListenPort(pid: number) {
  if (process.platform === "win32") {
    return detectWindowsListenPort(pid)
  }
  return detectLsofListenPort(pid) || detectSsListenPort(pid)
}

function detectWindowsListenPort(pid: number) {
  const script = `$ErrorActionPreference='SilentlyContinue'; ` + [
    `Get-NetTCPConnection -OwningProcess ${pid} -State Listen`,
    "Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::1' -or $_.LocalAddress -eq '::' }",
    "Sort-Object LocalPort",
    "Select-Object -First 1 -ExpandProperty LocalPort",
  ].join(" | ")
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true })
  return firstPort(result.stdout)
}

function detectLsofListenPort(pid: number) {
  const result = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-FnP"], { encoding: "utf8" })
  return firstPort(result.stdout)
}

function detectSsListenPort(pid: number) {
  const result = spawnSync("ss", ["-ltnp"], { encoding: "utf8" })
  const line = result.stdout
    .split(/\r?\n/)
    .find((item) => item.includes(`pid=${pid},`))
  return firstPort(line || "")
}

function firstPort(value: string) {
  const colonMatch = value.match(/:(\d+)(?:\s|$)/)
  const plainMatch = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^\d{2,5}$/.test(line))
  const rawPort = colonMatch?.[1] || plainMatch
  if (!rawPort) {
    return null
  }
  const port = Number(rawPort)
  return port > 0 && port <= 65535 ? port : null
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function updateBuiltinServerStatus(patch: Partial<BuiltinServerStatus>) {
  builtinServerStatus = {
    ...builtinServerStatus,
    ...patch,
    enabled: builtinServerEnabled,
    running: Boolean(builtinServerProcess && !builtinServerProcess.killed),
  }
  mainWindow?.webContents.send("builtin-server:status", builtinServerStatus)
  emitDesktopProcessStatus()
  return builtinServerStatus
}

function updateConnectorStatus(id: string, patch: Partial<ConnectorStatus>) {
  const connector = connectorProcesses.get(id)
  if (!connector) {
    return null
  }
  connector.status = {
    ...connector.status,
    ...patch,
    running: Boolean(connector.process && !connector.process.killed),
  }
  emitDesktopProcessStatus()
  return connector.status
}

function getDesktopProcessStatus(): DesktopProcessStatus {
  const builtinRunning = Boolean(builtinServerProcess && !builtinServerProcess.killed)
  const processes: ManagedProcessStatus[] = []
  if (builtinRunning) {
    processes.push({
      id: "builtin-server",
      kind: "builtin-server",
      running: true,
      phase: builtinServerStatus.phase,
      message: builtinServerStatus.message,
      pid: builtinServerProcess?.pid ?? null,
      version: builtinServerStatus.version,
      serverURL: builtinServerStatus.serverURL,
      enabled: builtinServerStatus.enabled,
    })
  }
  for (const connector of connectorProcesses.values()) {
    const connectorRunning = Boolean(connector.process && !connector.process.killed)
    if (!connectorRunning) {
      continue
    }
    processes.push({
      id: connector.status.id,
      kind: "connector",
      running: true,
      phase: connector.status.phase,
      message: connector.status.message,
      pid: connector.process?.pid ?? null,
      version: connector.status.version,
      serverURL: connector.status.serverURL,
      mode: connector.status.mode,
      startedAt: connector.status.startedAt,
    })
  }
  return {
    generatedAt: new Date().toISOString(),
    processes,
  }
}

function emitDesktopProcessStatus() {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("desktop-processes:status", getDesktopProcessStatus())
  }
}

function setupBuiltinServerIPC() {
  ipcMain.handle("builtin-server:get-status", () => builtinServerStatus)
  ipcMain.handle("builtin-server:set-enabled", async (_event, enabled: boolean) => {
    builtinServerEnabled = enabled
    await writeBuiltinServerConfig({ enabled })
    if (enabled) {
      await ensureBuiltinServerRunning()
    } else {
      stopBuiltinServer()
      updateBuiltinServerStatus({ phase: "idle", message: "", version: "" })
    }
    return builtinServerStatus
  })
  ipcMain.handle("connector:start", async (_event, input: StartConnectorInput) => startConnector(input))
  ipcMain.handle("connector:ensure-desktop", async (_event, input: { serverURL: string; authToken: string }) => ensureDesktopConnector(input))
  ipcMain.handle("desktop-processes:terminate", (_event, id: string) => terminateManagedProcess(id))
  ipcMain.handle("desktop-processes:get-status", () => getDesktopProcessStatus())
  ipcMain.handle("desktop-settings:get", () => desktopSettingsForRenderer())
  ipcMain.handle("desktop-settings:save", async (_event, input: DesktopSettings) => writeDesktopSettings(input))
  ipcMain.handle("desktop-settings:choose-file", async () => chooseDesktopExecutable())
  ipcMain.handle("desktop:get-system-info", () => ({ hostname: os.hostname(), platform: process.platform, instanceID: desktopInstanceID() }))
  ipcMain.handle("desktop:open-in-vscode", async (_event, workspacePath: string) => openWorkspaceInVSCode(workspacePath))
  ipcMain.handle("desktop:menu-action", (event, action: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (action === "new-window") {
      const nextWindow = createWindow()
      nextWindow.show()
      nextWindow.focus()
      return { ok: true }
    }
    if (action === "close-window") {
      window?.destroy()
      return { ok: true }
    }
    if (action === "quit") {
      isQuitting = true
      app.quit()
      return { ok: true }
    }
    if (!window || !["copy", "paste", "cut", "delete", "undo", "redo"].includes(String(action))) {
      return { ok: false }
    }
    const contents = window.webContents
    if (action === "copy") contents.copy()
    if (action === "paste") contents.paste()
    if (action === "cut") contents.cut()
    if (action === "delete") contents.delete()
    if (action === "undo") contents.undo()
    if (action === "redo") contents.redo()
    return { ok: true }
  })
  ipcMain.handle("desktop:open-link", async (_event, target: unknown) => {
    const links: Record<string, string> = {
      "official-site": "https://veloce.flweb.cn",
      github: "https://github.com/WindyPear-Team/veloce-desktop",
    }
    const url = typeof target === "string" ? links[target] : undefined
    if (!url) return { ok: false }
    await shell.openExternal(url)
    return { ok: true }
  })
  ipcMain.handle("desktop-update:check", async () => checkDesktopUpdate())
  ipcMain.handle("desktop-update:install-prepared", async () => installPreparedDesktopUpdate())
  ipcMain.handle("desktop-tabs:get-initial-state", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    return { windowID: window?.id || 0, tab: window ? initialWindowTabs.get(window.id) || null : null }
  })
  ipcMain.handle("desktop-tabs:detach", (event, input: unknown) => detachDesktopTab(event.sender, input))
}

function detachDesktopTab(sender: Electron.WebContents, input: unknown) {
  const sourceWindow = BrowserWindow.fromWebContents(sender)
  const tab = normalizeDesktopTab(input)
  if (!sourceWindow || !tab) {
    return { moved: false }
  }
  const point = isRecord(input) ? input : {}
  const screenX = finiteNumber(point.screenX)
  const screenY = finiteNumber(point.screenY)
  const targetWindow = BrowserWindow.getAllWindows().find((window) => {
    if (window.id === sourceWindow.id || window.isDestroyed()) {
      return false
    }
    const bounds = window.getBounds()
    return screenX >= bounds.x && screenX <= bounds.x + bounds.width && screenY >= bounds.y && screenY <= bounds.y + bounds.height
  })
  if (targetWindow) {
    targetWindow.webContents.send("desktop-tabs:received", tab)
    targetWindow.show()
    targetWindow.focus()
    return { moved: true, targetWindowID: targetWindow.id }
  }
  const window = createWindow(tab)
  return { moved: Boolean(window), targetWindowID: window?.id || 0 }
}

function normalizeDesktopTab(value: unknown): DesktopTab | null {
  if (!isRecord(value)) {
    return null
  }
  const id = typeof value.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value.id) ? value.id : ""
  if (!id) {
    return null
  }
  const title = typeof value.title === "string" ? value.title.trim().slice(0, 40) : "Chat"
  const serverURL = typeof value.serverURL === "string" ? value.serverURL.trim().slice(0, 2048) : ""
  const pagePath = typeof value.path === "string" && value.path.startsWith("/") ? value.path.slice(0, 1024) : "/chat"
  return { id, title: title || "Chat", serverURL, path: pagePath }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object"
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : -1
}

async function openWorkspaceInVSCode(workspacePath: string) {
  const targetPath = workspacePath.trim()
  if (!targetPath || !path.isAbsolute(targetPath)) {
    return { ok: false, message: "A local absolute workspace path is required" }
  }
  try {
    await shell.openExternal(`vscode://file${pathToFileURL(targetPath).pathname}`)
    return { ok: true, message: "VS Code opened" }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Failed to open VS Code" }
  }
}

async function ensureBuiltinServerRunning() {
  if (builtinServerProcess && !builtinServerProcess.killed) {
    return updateBuiltinServerStatus({ phase: "running", message: "Built-in server is running", serverURL: builtinServerStatus.serverURL || builtinServerURL() })
  }

  try {
    updateBuiltinServerStatus({ phase: "checking", message: "Preparing bundled built-in server", serverURL: "" })
    const install = await ensureLatestCommunityInstall()
    await prepareBuiltinServerRuntime()
    updateBuiltinServerStatus({ phase: "starting", message: "Starting built-in server", version: install.tagName })
    builtinServerProcess = spawn(install.executablePath, [], {
      cwd: builtinServerRuntimeDir(),
      env: builtinServerEnv(),
      stdio: "ignore",
      windowsHide: true,
    })
    builtinServerProcess.on("exit", () => {
      builtinServerProcess = null
      if (!isQuitting && builtinServerEnabled) {
        updateBuiltinServerStatus({ phase: "error", message: "Built-in server stopped unexpectedly" })
      }
    })
    builtinServerProcess.unref()
    const serverURL = await resolveBuiltinServerURL(builtinServerProcess.pid)
    return updateBuiltinServerStatus({ phase: "running", message: "Built-in server is running", serverURL, version: install.tagName })
  } catch (error) {
    return updateBuiltinServerStatus({
      phase: "error",
      message: error instanceof Error ? error.message : "Failed to start built-in server",
    })
  }
}

function stopBuiltinServer() {
  if (!builtinServerProcess) {
    return
  }
  builtinServerProcess.kill()
  builtinServerProcess = null
}

async function prepareBuiltinServerRuntime() {
  const runtimeDir = builtinServerRuntimeDir()
  const dbPath = builtinServerDBPath()
  await fsp.mkdir(runtimeDir, { recursive: true })
  if (fs.existsSync(dbPath)) {
    return
  }
  const legacyDBPath = await findLegacyBuiltinServerDB()
  if (legacyDBPath) {
    await fsp.mkdir(path.dirname(dbPath), { recursive: true })
    await fsp.copyFile(legacyDBPath, dbPath)
  }
}

async function findLegacyBuiltinServerDB() {
  const communityRoot = path.join(veloceDataDir(), "community")
  const candidates: Array<{ filePath: string; mtimeMs: number }> = []
  await collectLegacyDBFiles(communityRoot, candidates)
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return candidates[0]?.filePath || null
}

async function collectLegacyDBFiles(root: string, candidates: Array<{ filePath: string; mtimeMs: number }>) {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      await collectLegacyDBFiles(fullPath, candidates)
      continue
    }
    if (entry.name.toLowerCase() !== "flai.db") {
      continue
    }
    const stat = await fsp.stat(fullPath).catch(() => null)
    if (stat?.isFile()) {
      candidates.push({ filePath: fullPath, mtimeMs: stat.mtimeMs })
    }
  }
}

async function ensureLatestCommunityInstall() {
  const customPath = desktopSettings.builtinServerPath.trim()
  if (customPath) {
    await assertExecutableFile(customPath, "Built-in server")
    return {
      tagName: "custom",
      assetName: path.basename(customPath),
      executablePath: customPath,
    }
  }
  return bundledRuntimeInstall("flai-community", "Built-in server")
}

async function ensureLatestConnectorInstall() {
  const customPath = desktopSettings.connectorPath.trim()
  if (customPath) {
    await assertExecutableFile(customPath, "Connector")
    return {
      tagName: "custom",
      assetName: path.basename(customPath),
      executablePath: customPath,
    }
  }
  return bundledRuntimeInstall("veloce-connector", "Connector")
}

async function bundledRuntimeInstall(binaryName: string, label: string) {
  const executableName = process.platform === "win32" ? `${binaryName}.exe` : binaryName
  const resourceRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "resources")
  const executablePath = path.join(resourceRoot, "bin", executableName)
  await assertExecutableFile(executablePath, label)
  if (process.platform !== "win32") {
    await fsp.chmod(executablePath, 0o755)
  }
  return {
    tagName: app.getVersion(),
    assetName: executableName,
    executablePath,
  }
}

async function startConnector(input: StartConnectorInput) {
  const serverURL = input.serverURL.trim()
  const token = input.token.trim()
  if (!serverURL || !token) {
    return { ok: false, message: "Missing connector server URL or token", version: "" }
  }
  const deviceKind = input.deviceKind === "desktop" ? "desktop" : "cli"
  const deviceID = input.deviceID?.trim() || ""
  const existing = Array.from(connectorProcesses.values()).find((connector) =>
    connector.status.deviceKind === deviceKind &&
    connector.status.serverURL === serverURL &&
    (deviceKind !== "desktop" || connector.status.deviceID === deviceID)
  )
  if (existing?.process && !existing.process.killed && !input.restart) {
    return { ok: true, message: "Connector is already running", version: existing.status.version }
  }
  if (existing) {
    existing.process?.kill()
    connectorProcesses.delete(existing.status.id)
  }
  const connectorID = `connector-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  connectorProcesses.set(connectorID, {
    process: null,
    status: {
      id: connectorID,
      running: false,
      phase: "checking",
      message: "Preparing bundled connector",
      serverURL,
      version: "",
      mode: input.mode,
      startedAt: "",
      deviceID,
      deviceKind,
    },
  })
  emitDesktopProcessStatus()
  try {
    const useGoRunConnector = !app.isPackaged && !desktopSettings.connectorPath.trim()
    updateConnectorStatus(connectorID, { phase: "checking", message: useGoRunConnector ? "Preparing connector from ../app" : "Preparing bundled connector", serverURL, mode: input.mode })
    const install = useGoRunConnector ? null : await ensureLatestConnectorInstall()
    const connectorVersion = useGoRunConnector ? "dev" : install!.tagName
    updateConnectorStatus(connectorID, { phase: "starting", message: useGoRunConnector ? "Starting connector from ../app" : "Starting connector", serverURL, version: connectorVersion, mode: input.mode })
    const args = ["-server", serverURL, "-token", token, "-device-kind", deviceKind]
    if (deviceKind === "desktop") {
      args.push("-desktop-instance-id", input.desktopInstanceID?.trim() || desktopInstanceID())
    }
    if (input.mode === "web_server") {
      args.push("-mode", "web_server", "-web-port", String(input.webPort || 8080))
    }
    const childProcess = spawn(
      useGoRunConnector ? (process.platform === "win32" ? "go.exe" : "go") : install!.executablePath,
      useGoRunConnector ? ["run", ".", ...args] : args,
      {
        cwd: useGoRunConnector ? path.resolve(__dirname, "..", "..", "app") : path.dirname(install!.executablePath),
        env: desktopProcessEnv(),
        stdio: "ignore",
        windowsHide: true,
      }
    )
    const connector = connectorProcesses.get(connectorID)
    if (connector) {
      connector.process = childProcess
    }
    childProcess.on("exit", () => {
      connectorProcesses.delete(connectorID)
      emitDesktopProcessStatus()
    })
    childProcess.unref()
    updateConnectorStatus(connectorID, {
      phase: "running",
      message: "Connector is running",
      serverURL,
      version: connectorVersion,
      mode: input.mode,
      startedAt: new Date().toISOString(),
      deviceID,
      deviceKind,
    })
    return { ok: true, message: "Connector started", version: connectorVersion }
  } catch (error) {
    connectorProcesses.delete(connectorID)
    emitDesktopProcessStatus()
    return { ok: false, message: error instanceof Error ? error.message : "Failed to start connector", version: "" }
  }
}

function ensureDesktopConnector(input: { serverURL: string; authToken: string }) {
  const key = input.serverURL.trim().replace(/\/+$/, "")
  const pending = desktopConnectorEnsureRequests.get(key)
  if (pending) {
    return pending
  }
  const request = ensureDesktopConnectorForServer(input).finally(() => {
    desktopConnectorEnsureRequests.delete(key)
  })
  desktopConnectorEnsureRequests.set(key, request)
  return request
}

async function ensureDesktopConnectorForServer(input: { serverURL: string; authToken: string }) {
  const serverURL = input.serverURL.trim().replace(/\/+$/, "")
  const authToken = input.authToken.trim()
  if (!/^https?:\/\//i.test(serverURL) || !authToken) {
    return { ok: false, message: "Missing desktop connector server URL or login token", version: "" }
  }
  const savedToken = desktopSettings.desktopConnectorTokens[serverURL] || ""
  try {
    const response = await fetch(`${serverURL}/api/user/advanced-chat/devices/desktop/ensure`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
        ...(savedToken ? { "X-Desktop-Connector-Token": savedToken } : {}),
      },
      body: JSON.stringify({
        desktop_instance_id: desktopInstanceID(),
        hostname: os.hostname(),
        os: process.platform,
        arch: process.arch,
        version: app.getVersion(),
      }),
    })
    const payload = await response.json().catch(() => ({})) as { token?: unknown; device?: { id?: unknown } }
    if (!response.ok) {
      throw new Error(typeof (payload as { error?: unknown }).error === "string" ? (payload as { error: string }).error : `HTTP ${response.status}`)
    }
    const token = typeof payload.token === "string" && payload.token.trim() ? payload.token.trim() : savedToken
    const deviceID = typeof payload.device?.id === "string" ? payload.device.id.trim() : ""
    if (!token || !deviceID) {
      throw new Error("Desktop connector credentials are unavailable")
    }
    if (token !== savedToken) {
      desktopSettings.desktopConnectorTokens[serverURL] = token
      await fsp.mkdir(veloceDataDir(), { recursive: true })
      await fsp.writeFile(desktopSettingsPath(), JSON.stringify(desktopSettings, null, 2))
    }
    return startConnector({
      serverURL,
      token,
      mode: "platform",
      deviceID,
      deviceKind: "desktop",
      desktopInstanceID: desktopInstanceID(),
      restart: token !== savedToken,
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Failed to connect desktop connector", version: "" }
  }
}

function terminateManagedProcess(id: string) {
  if (id === "builtin-server") {
    builtinServerEnabled = false
    void writeBuiltinServerConfig({ enabled: false })
    stopBuiltinServer()
    updateBuiltinServerStatus({ phase: "idle", message: "", version: "" })
    return getDesktopProcessStatus()
  }

  const connector = connectorProcesses.get(id)
  if (!connector) {
    return getDesktopProcessStatus()
  }
  connector.process?.kill()
  connectorProcesses.delete(id)
  emitDesktopProcessStatus()
  return getDesktopProcessStatus()
}

function stopAllConnectors() {
  for (const connector of connectorProcesses.values()) {
    connector.process?.kill()
  }
  connectorProcesses.clear()
  emitDesktopProcessStatus()
}

async function assertExecutableFile(filePath: string, label: string) {
  const stat = await fsp.stat(filePath).catch(() => null)
  if (!stat?.isFile()) {
    throw new Error(`${label} file does not exist`)
  }
}

async function chooseDesktopExecutable() {
  const options = {
    title: "Select executable",
    properties: ["openFile"] as Array<"openFile">,
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? "" : result.filePaths[0] || ""
}

async function checkDesktopUpdate(): Promise<DesktopUpdateResult> {
  const prepared = desktopSettings.preparedUpdate
  if (prepared && fs.existsSync(prepared.filePath)) {
    return {
      state: "ready",
      message: "Update is ready",
      version: prepared.tagName,
      filePath: prepared.filePath,
    }
  }

  try {
    const release = await requestJSON<GitHubRelease>("https://api.github.com/repos/WindyPear-Team/veloce-desktop/releases/latest")
    const asset = selectDesktopUpdateAsset(release.assets)
    if (!asset) {
      return { state: "not_available", message: "No compatible desktop update asset found", version: release.tag_name }
    }

    const root = path.join(veloceDataDir(), "desktop-updates", safePathSegment(release.tag_name))
    await fsp.mkdir(root, { recursive: true })
    const downloadPath = path.join(root, asset.name)
    if (!fs.existsSync(downloadPath)) {
      await downloadFile(asset.browser_download_url, downloadPath)
    }
    await writeDesktopSettings({
      ...desktopSettings,
      preparedUpdate: {
        tagName: release.tag_name,
        assetName: asset.name,
        filePath: downloadPath,
      },
    })
    return {
      state: "ready",
      message: "Update is ready",
      version: release.tag_name,
      filePath: downloadPath,
    }
  } catch (error) {
    return {
      state: "error",
      message: error instanceof Error ? error.message : "Failed to check updates",
      version: "",
    }
  }
}

async function installPreparedDesktopUpdate() {
  const prepared = desktopSettings.preparedUpdate
  if (!prepared || !fs.existsSync(prepared.filePath)) {
    return { ok: false, message: "No prepared update installer" }
  }
  isQuitting = true
  if (process.platform === "win32" && prepared.filePath.toLowerCase().endsWith(".exe")) {
    spawn(prepared.filePath, [], {
      cwd: path.dirname(prepared.filePath),
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    }).unref()
  } else {
    await shell.openPath(prepared.filePath)
  }
  app.quit()
  return { ok: true, message: "Installer started" }
}

function selectDesktopUpdateAsset(assets: GitHubReleaseAsset[]) {
  const suffixes = desktopUpdateSuffixes()
  return assets.find((asset) => {
    const normalized = asset.name.toLowerCase()
    if (normalized.endsWith(".blockmap") || normalized.endsWith(".yml") || normalized.endsWith(".yaml")) {
      return false
    }
    return suffixes.some((suffix) => normalized.endsWith(suffix))
  }) || null
}

function desktopUpdateSuffixes() {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : ""
  if (!arch) {
    return []
  }
  if (process.platform === "win32") {
    return [`-win-${arch}.exe`]
  }
  if (process.platform === "darwin") {
    return [`-mac-${arch}.dmg`]
  }
  if (process.platform === "linux") {
    return [`-linux-${arch}.appimage`, `-linux-${arch}.deb`]
  }
  return []
}

function safePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function requestJSON<T>(url: string) {
  return new Promise<T>((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": "VeloceDesktop/0.1" } }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        requestJSON<T>(response.headers.location).then(resolve, reject)
        return
      }
      if (response.statusCode !== 200) {
        reject(new Error(`GitHub request failed: HTTP ${response.statusCode}`))
        return
      }
      let raw = ""
      response.setEncoding("utf8")
      response.on("data", (chunk) => {
        raw += chunk
      })
      response.on("end", () => {
        try {
          resolve(JSON.parse(raw) as T)
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on("error", reject)
  })
}

function downloadFile(url: string, destination: string) {
  return new Promise<void>((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": "VeloceDesktop/0.1" } }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadFile(response.headers.location, destination).then(resolve, reject)
        return
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${response.statusCode}`))
        return
      }
      const file = fs.createWriteStream(destination)
      response.pipe(file)
      file.on("finish", () => {
        file.close((error) => error ? reject(error) : resolve())
      })
      file.on("error", reject)
    })
    request.on("error", reject)
  })
}

function handleNavigationURL(event: Electron.Event, rawURL: string) {
  const token = tokenFromURL(rawURL)
  if (token) {
    event.preventDefault()
    loadLocalApp(`/chat?token=${encodeURIComponent(token)}`)
    return
  }

  const parsedURL = new URL(rawURL)
  if (parsedURL.protocol === "file:" || parsedURL.protocol === "http:" || parsedURL.protocol === "https:") {
    return
  }

  event.preventDefault()
  void shell.openExternal(rawURL)
}

function createTray() {
  if (tray) {
    return
  }
  tray = new Tray(iconPath)
  tray.setToolTip("Veloce")
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示 Veloce", click: showMainWindow },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ]))
  tray.on("click", showMainWindow)
}

function createWindow(initialTab?: DesktopTab) {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "Veloce",
    icon: iconPath,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#ffffff00",
      symbolColor: "#111827",
      height: 36,
    },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: false,
    },
  })

  if (initialTab) {
    initialWindowTabs.set(window.id, initialTab)
  }
  if (!mainWindow) {
    mainWindow = window
  }
  window.webContents.on("will-navigate", handleNavigationURL)
  window.webContents.on("will-redirect", handleNavigationURL)
  window.webContents.setWindowOpenHandler(({ url }) => {
    const token = tokenFromURL(url)
    if (token) {
      loadLocalApp(`/chat?token=${encodeURIComponent(token)}`)
    } else {
      void shell.openExternal(url)
    }
    return { action: "deny" }
  })
  window.on("close", (event) => {
    if (isQuitting || window !== mainWindow) {
      return
    }
    event.preventDefault()
    window.hide()
  })
  window.on("closed", () => {
    initialWindowTabs.delete(window.id)
    if (mainWindow === window) {
      mainWindow = BrowserWindow.getAllWindows().find((candidate) => candidate !== window) || null
    }
  })

  void window.loadFile(indexPath)
  return window
}

if (gotSingleInstanceLock) {
  setupBuiltinServerIPC()

  app.whenReady().then(async () => {
    desktopSettings = await readDesktopSettings()
    applyDesktopProxySettings()
    const config = await readBuiltinServerConfig()
    builtinServerEnabled = Boolean(config.enabled)
    updateBuiltinServerStatus({ enabled: builtinServerEnabled })
    createTray()
    createWindow()
    if (builtinServerEnabled) {
      void ensureBuiltinServerRunning()
    }
    app.on("activate", showMainWindow)
  })
}

app.on("before-quit", () => {
  isQuitting = true
  stopBuiltinServer()
  stopAllConnectors()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})
