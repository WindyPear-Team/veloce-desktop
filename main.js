import { app, BrowserWindow, shell } from "electron"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const indexPath = path.join(__dirname, "dist", "web", "index.html")

let mainWindow = null

function tokenFromURL(rawURL) {
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

function handleNavigationURL(event, rawURL) {
  const token = tokenFromURL(rawURL)
  if (token) {
    event.preventDefault()
    loadLocalApp(`/chat?token=${encodeURIComponent(token)}`)
    return
  }

  const parsedURL = new URL(rawURL)
  if (parsedURL.protocol === "file:") {
    return
  }

  if (parsedURL.protocol === "http:" || parsedURL.protocol === "https:") {
    return
  }

  event.preventDefault()
  void shell.openExternal(rawURL)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "Veloce",
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

  loadLocalApp()
}

app.whenReady().then(() => {
  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})
