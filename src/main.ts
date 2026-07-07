import { app, BrowserWindow, Menu, Tray, shell } from "electron"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const indexPath = path.join(__dirname, "web", "index.html")
const iconPath = path.join(__dirname, "..", "assets", "logo.png")

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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

app.whenReady().then(() => {
  createTray()
  createWindow()
  app.on("activate", showMainWindow)
})

app.on("before-quit", () => {
  isQuitting = true
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})
