// Throwaway envelope benchmark: the same external Go/React URL for every shell.
const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const url = process.argv.find((arg) => arg.startsWith('http://127.0.0.1:'))
  if (!url) throw new Error('Missing local benchmark URL')
  const window = new BrowserWindow({
    width: 1280,
    height: 720,
    useContentSize: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  window.loadURL(url)
})
app.on('window-all-closed', () => app.quit())
