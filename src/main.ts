import { app, BrowserWindow, Menu, Tray, ipcMain, shell } from "electron"
import { spawn, spawnSync } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const indexPath = path.join(__dirname, "web", "index.html")
const iconPath = path.join(__dirname, "..", "assets", "logo.png")
const preloadPath = path.join(__dirname, "preload.cjs")
const builtinServerURL = "http://localhost:12789"

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let builtinServerEnabled = false
let builtinServerProcess: ChildProcess | null = null

type BuiltinServerPhase = "idle" | "checking" | "downloading" | "starting" | "running" | "error"

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

interface BuiltinServerInstallMeta {
  tagName: string
  assetName: string
  executablePath: string
}

let builtinServerStatus: BuiltinServerStatus = {
  enabled: false,
  running: false,
  phase: "idle",
  message: "",
  serverURL: builtinServerURL,
  version: "",
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

function builtinServerRoot() {
  return path.join(veloceDataDir(), "community")
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

function updateBuiltinServerStatus(patch: Partial<BuiltinServerStatus>) {
  builtinServerStatus = {
    ...builtinServerStatus,
    ...patch,
    enabled: builtinServerEnabled,
    running: Boolean(builtinServerProcess && !builtinServerProcess.killed),
  }
  mainWindow?.webContents.send("builtin-server:status", builtinServerStatus)
  return builtinServerStatus
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
}

async function ensureBuiltinServerRunning() {
  if (builtinServerProcess && !builtinServerProcess.killed) {
    return updateBuiltinServerStatus({ phase: "running", message: "Built-in server is running", serverURL: builtinServerURL })
  }

  try {
    updateBuiltinServerStatus({ phase: "checking", message: "Checking latest community release", serverURL: builtinServerURL })
    const install = await ensureLatestCommunityInstall()
    updateBuiltinServerStatus({ phase: "starting", message: "Starting built-in server", version: install.tagName })
    builtinServerProcess = spawn(install.executablePath, [], {
      cwd: path.dirname(install.executablePath),
      env: { ...process.env },
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
    return updateBuiltinServerStatus({ phase: "running", message: "Built-in server is running", serverURL: builtinServerURL, version: install.tagName })
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

async function ensureLatestCommunityInstall() {
  const release = await requestJSON<GitHubRelease>("https://api.github.com/repos/WindyPear-Team/veloce/releases/latest")
  const asset = selectCommunityAsset(release.assets)
  if (!asset) {
    throw new Error("No compatible community release asset found")
  }

  const root = builtinServerRoot()
  const metaPath = path.join(root, "latest.json")
  const currentMeta = await readInstallMeta(metaPath)
  if (currentMeta?.tagName === release.tag_name && fs.existsSync(currentMeta.executablePath)) {
    return currentMeta
  }

  updateBuiltinServerStatus({ phase: "downloading", message: `Downloading ${release.tag_name}`, version: release.tag_name })
  const versionDir = path.join(root, safePathSegment(release.tag_name))
  const downloadDir = path.join(root, "downloads")
  await fsp.rm(versionDir, { recursive: true, force: true })
  await fsp.mkdir(versionDir, { recursive: true })
  await fsp.mkdir(downloadDir, { recursive: true })

  const downloadPath = path.join(downloadDir, asset.name)
  await downloadFile(asset.browser_download_url, downloadPath)
  const executablePath = await installDownloadedAsset(downloadPath, versionDir)
  const meta: BuiltinServerInstallMeta = { tagName: release.tag_name, assetName: asset.name, executablePath }
  await fsp.mkdir(root, { recursive: true })
  await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2))
  return meta
}

async function readInstallMeta(metaPath: string) {
  try {
    const raw = await fsp.readFile(metaPath, "utf8")
    return JSON.parse(raw) as BuiltinServerInstallMeta
  } catch {
    return null
  }
}

function selectCommunityAsset(assets: GitHubReleaseAsset[]) {
  let best: { asset: GitHubReleaseAsset; score: number } | null = null
  for (const asset of assets) {
    const score = scoreAsset(asset.name)
    if (score > (best?.score ?? -1)) {
      best = { asset, score }
    }
  }
  return best && best.score > 0 ? best.asset : null
}

function scoreAsset(name: string) {
  const normalized = name.toLowerCase()
  let score = 0
  if (normalized.includes("desktop")) {
    return -1
  }
  if (normalized.includes("community")) {
    score += 20
  }
  if (normalized.includes("veloce")) {
    score += 5
  }
  if (process.platform === "win32") {
    if (!/(win|windows)/.test(normalized) && !normalized.endsWith(".exe")) {
      return -1
    }
    score += normalized.endsWith(".exe") ? 10 : 6
  } else if (process.platform === "linux") {
    if (!/(linux|gnu)/.test(normalized)) {
      return -1
    }
    score += 8
  } else if (process.platform === "darwin") {
    if (!/(darwin|mac|macos|osx)/.test(normalized)) {
      return -1
    }
    score += 8
  }
  if (process.arch === "x64" && /(x64|amd64)/.test(normalized)) {
    score += 8
  }
  if (process.arch === "arm64" && /(arm64|aarch64)/.test(normalized)) {
    score += 8
  }
  if (/\.(zip|tar\.gz|tgz|exe)$/.test(normalized)) {
    score += 4
  }
  return score
}

async function installDownloadedAsset(downloadPath: string, versionDir: string) {
  const lower = downloadPath.toLowerCase()
  if (process.platform === "win32" && lower.endsWith(".exe")) {
    const targetPath = path.join(versionDir, path.basename(downloadPath))
    await fsp.copyFile(downloadPath, targetPath)
    return targetPath
  }

  if (/\.(zip|tar\.gz|tgz)$/.test(lower)) {
    extractArchive(downloadPath, versionDir)
  } else {
    const targetPath = path.join(versionDir, path.basename(downloadPath))
    await fsp.copyFile(downloadPath, targetPath)
    if (process.platform !== "win32") {
      await fsp.chmod(targetPath, 0o755)
    }
    return targetPath
  }

  const executablePath = await findCommunityExecutable(versionDir)
  if (!executablePath) {
    throw new Error("Downloaded community release does not contain an executable")
  }
  if (process.platform !== "win32") {
    await fsp.chmod(executablePath, 0o755)
  }
  return executablePath
}

function extractArchive(archivePath: string, destination: string) {
  const tar = spawnSync("tar", ["-xf", archivePath, "-C", destination], { stdio: "ignore" })
  if (tar.status === 0) {
    return
  }

  const fallback = process.platform === "win32"
    ? spawnSync("powershell.exe", ["-NoProfile", "-Command", "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force", archivePath, destination], { stdio: "ignore" })
    : spawnSync("unzip", ["-q", "-o", archivePath, "-d", destination], { stdio: "ignore" })

  if (fallback.status !== 0) {
    throw new Error("Failed to extract community release")
  }
}

async function findCommunityExecutable(root: string): Promise<string | null> {
  const entries = await fsp.readdir(root, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = await findCommunityExecutable(fullPath)
      if (nested) {
        files.push(nested)
      }
    } else if (isExecutableCandidate(entry.name)) {
      files.push(fullPath)
    }
  }
  files.sort((left, right) => executableScore(right) - executableScore(left))
  return files[0] || null
}

function isExecutableCandidate(name: string) {
  const normalized = name.toLowerCase()
  if (process.platform === "win32") {
    return normalized.endsWith(".exe")
  }
  return !/\.(txt|md|json|yaml|yml|html|css|js|map|so|dll|dylib)$/.test(normalized)
}

function executableScore(filePath: string) {
  const normalized = path.basename(filePath).toLowerCase()
  let score = 0
  if (normalized.includes("community")) {
    score += 20
  }
  if (normalized.includes("veloce")) {
    score += 10
  }
  if (normalized.includes("flai")) {
    score += 5
  }
  if (normalized.endsWith(".exe")) {
    score += 3
  }
  return score
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
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})
