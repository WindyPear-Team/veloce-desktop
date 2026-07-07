# Veloce Desktop

Electron shell for the desktop build of the Veloce web app.

The desktop bundle reuses the web source code, but Vite resolves `@/AppEntry` to `web/src/App.desktop.tsx` when built with `--mode desktop`. The desktop app only includes login/setup and `/chat/*` routes, then connects to an existing Veloce server selected in the app.

## Run

```bash
npm install
npm run start
```

`npm run start` first builds the desktop web bundle into `desktop/dist/web`, then starts Electron.

## Build Web Assets Only

```bash
npm run build:web
```

Server selection is stored in local storage under `veloce.desktop.server_url`; the default is `http://localhost:12789`.
