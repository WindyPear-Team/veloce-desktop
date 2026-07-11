import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell } from "electron"
import { spawn, spawnSync } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import https from "node:https"
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

let desktopSettings: DesktopSettings = {
  httpProxy: "",
  builtinServerPath: "",
  connectorPath: "",
  preparedUpdate: null,
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
  desktopSettings = normalizeDesktopSettings(settings)
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
  return {
    httpProxy: typeof item.httpProxy === "string" ? item.httpProxy.trim() : "",
    builtinServerPath: typeof item.builtinServerPath === "string" ? item.builtinServerPath.trim() : "",
    connectorPath: typeof item.connectorPath === "string" ? item.connectorPath.trim() : "",
    preparedUpdate: prepared && typeof prepared.tagName === "string" && typeof prepared.assetName === "string" && typeof prepared.filePath === "string"
      ? { tagName: prepared.tagName, assetName: prepared.assetName, filePath: prepared.filePath }
      : null,
  }
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
  mainWindow?.webContents.send("desktop-processes:status", getDesktopProcessStatus())
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
  ipcMain.handle("desktop-processes:terminate", (_event, id: string) => terminateManagedProcess(id))
  ipcMain.handle("desktop-processes:get-status", () => getDesktopProcessStatus())
  ipcMain.handle("desktop-settings:get", () => desktopSettings)
  ipcMain.handle("desktop-settings:save", async (_event, input: DesktopSettings) => writeDesktopSettings(input))
  ipcMain.handle("desktop-settings:choose-file", async () => chooseDesktopExecutable())
  ipcMain.handle("desktop:get-system-info", () => ({ hostname: os.hostname(), platform: process.platform }))
  ipcMain.handle("desktop:open-in-vscode", async (_event, workspacePath: string) => openWorkspaceInVSCode(workspacePath))
  ipcMain.handle("desktop-update:check", async () => checkDesktopUpdate())
  ipcMain.handle("desktop-update:install-prepared", async () => installPreparedDesktopUpdate())
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
    },
  })
  emitDesktopProcessStatus()
  try {
    updateConnectorStatus(connectorID, { phase: "checking", message: "Preparing bundled connector", serverURL, mode: input.mode })
    const install = await ensureLatestConnectorInstall()
    updateConnectorStatus(connectorID, { phase: "starting", message: "Starting connector", serverURL, version: install.tagName, mode: input.mode })
    const args = ["-server", serverURL, "-token", token]
    if (input.mode === "web_server") {
      args.push("-mode", "web_server", "-web-port", String(input.webPort || 8080))
    }
    const childProcess = spawn(install.executablePath, args, {
      cwd: path.dirname(install.executablePath),
      env: desktopProcessEnv(),
      stdio: "ignore",
      windowsHide: true,
    })
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
      version: install.tagName,
      mode: input.mode,
      startedAt: new Date().toISOString(),
    })
    return { ok: true, message: "Connector started", version: install.tagName }
  } catch (error) {
    connectorProcesses.delete(connectorID)
    emitDesktopProcessStatus()
    return { ok: false, message: error instanceof Error ? error.message : "Failed to start connector", version: "" }
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

function createWindow() {
  mainWindow = new BrowserWindow({
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

  mainWindow.webContents.on("will-navigate", handleNavigationURL)
  mainWindow.webContents.on("will-redirect", handleNavigationURL)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const token = tokenFromURL(url)
    if (token) {
      loadLocalApp(`/chat?token=${encodeURIComponent(token)}`)
    } else {
      void shell.openExternal(url)
    }
    return { action: "deny" }
  })
  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return
    }
    event.preventDefault()
    mainWindow?.hide()
  })
  mainWindow.on("closed", () => {
    mainWindow = null
  })

  loadLocalApp()
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
