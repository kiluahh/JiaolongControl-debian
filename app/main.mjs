/** JiaoLongControl Debian 外壳（Electron） */
import {app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell, Notification} from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import {fileURLToPath} from 'node:url'
import {callDaemon, pingDaemon} from './bridge.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DEV_URL = process.env.JLC_DEV_URL || null
const ICON = path.join(ROOT, 'client', 'src', 'assets', 'icon', 'icon.png')

let win = null
let tray = null

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    frame: false,
    show: false,
    backgroundColor: '#0b0d10',
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (DEV_URL) {
    win.loadURL(DEV_URL)
  } else {
    const index = path.join(ROOT, 'client', 'dist', 'index.html')
    if (!fs.existsSync(index)) {
      win.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            `<body style="background:#111;color:#eee;font:14px system-ui;padding:40px">
             <h2>前端未构建</h2><p>请先运行：<code>cd client &amp;&amp; npx vite build</code></p></body>`,
          ),
      )
    } else {
      win.loadFile(index)
    }
  }

  win.once('ready-to-show', () => win.show())
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })
}

function buildTray() {
  try {
    const img = nativeImage.createFromPath(ICON)
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({width: 22, height: 22}))
    tray.setToolTip('JiaoLongControl')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {label: '显示主界面', click: () => win?.show()},
        {type: 'separator'},
        {
          label: '退出',
          click: () => {
            app.isQuitting = true
            app.quit()
          },
        },
      ]),
    )
    tray.on('click', () => (win?.isVisible() ? win.hide() : win?.show()))
  } catch (e) {
    console.error('托盘创建失败（GNOME 需要 AppIndicator 扩展）:', e.message)
  }
}

ipcMain.handle('jlc:call', async (_e, {group, method, args}) => {
  const res = await callDaemon(group, method, args)
  return res
})

ipcMain.on('jlc:window', (e, message) => {
  if (!win) return
  switch (message) {
    case 'window-minimize':
      win.minimize()
      break
    case 'window-maximize':
      win.isMaximized() ? win.unmaximize() : win.maximize()
      break
    case 'window-close':
      win.hide()
      break
    case 'window-drag':
      // Wayland 不允许应用移动自身窗口，拖动由 preload 注入的 app-region 完成
      break
  }
})

app.whenReady().then(async () => {
  createWindow()
  buildTray()

  const ping = await pingDaemon()
  if (!ping.Success) {
    console.warn(ping.Message)
    if (Notification.isSupported()) {
      new Notification({
        title: 'JiaoLongControl',
        body: `${ping.Message}\n硬件控制不可用，仅显示监控数据。`,
      }).show()
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // 常驻托盘：不退出
})
